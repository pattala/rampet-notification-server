// /api/send-notification.js
// Envío de notificaciones FCM en modo "data-only" + TRACKING "sent" por usuario.
//
// Requiere env vars:
// - GOOGLE_CREDENTIALS_JSON
// - API_SECRET_KEY
// - CORS_ALLOWED_ORIGINS
// - (opcional) PUSH_ICON_URL, PUSH_BADGE_URL

import admin from "firebase-admin";

// ---------- Inicialización Firebase Admin (singleton) ----------
function initFirebaseAdmin() {
  if (!admin.apps.length) {
    const credsRaw = process.env.GOOGLE_CREDENTIALS_JSON || "";
    if (!credsRaw) throw new Error("Falta GOOGLE_CREDENTIALS_JSON en variables de entorno.");
    let creds;
    try {
      creds = JSON.parse(credsRaw);
    } catch {
      // soporte por si viene con \n escapados
      const fallback = credsRaw.replace(/\\n/g, "\n");
      creds = JSON.parse(fallback);
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: creds.project_id,
        clientEmail: creds.client_email,
        privateKey: creds.private_key?.replace(/\\n/g, "\n"),
      }),
    });
  }
  return admin;
}
function getDb() { initFirebaseAdmin(); return admin.firestore(); }

// ---------- Utilidades ----------
function parseAllowedOrigins() {
  const raw = (process.env.CORS_ALLOWED_ORIGINS || "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function applyCors(req, res) {
  const allowed = parseAllowedOrigins();
  const origin = req.headers.origin || "";
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}
function ensureAuth(req) {
  const required = process.env.API_SECRET_KEY || "";
  if (!required) return true; // (no recomendado en prod)
  const got = req.headers["x-api-key"] || req.headers["X-API-Key"];
  return got === required;
}
function asStringRecord(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

// ---- Helpers TRACKING ----
async function resolveDestinatarios({ db, tokens = [], audience }) {
  // Preferimos audience.docIds si viene desde el Panel/Campañas
  let destinatarios = [];
  if (audience && Array.isArray(audience.docIds) && audience.docIds.length) {
    destinatarios = audience.docIds.map(id => ({ id }));
  }
  // Si no hay audience, mapeamos cada token a un cliente por fcmTokens
  if (!destinatarios.length && Array.isArray(tokens)) {
    for (const tk of tokens) {
      const q = await db.collection("clientes")
        .where("fcmTokens", "array-contains", tk)
        .limit(1).get();
      if (!q.empty) destinatarios.push({ id: q.docs[0].id, token: tk });
    }
  }
  // De-dup
  const seen = new Set();
  return destinatarios.filter(d => !seen.has(d.id) && seen.add(d.id));
}

async function createInboxSent({ db, clienteId, notifId, dataForDoc, token }) {
  const ref = db.collection("clientes").doc(clienteId).collection("inbox").doc(notifId);
  await ref.set({
    title: dataForDoc.title || "",
    body:  dataForDoc.body  || "",
    url:   dataForDoc.url   || "/notificaciones",
    tag:   dataForDoc.tag   || null,
    source: "simple",           // en campañas usaremos "campania"
    campaignId: null,
    token: token || null,
    status: "sent",
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return ref.id;
}

// ---------- Handler principal ----------
export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed. Use POST." });
  }
  if (!ensureAuth(req)) return res.status(401).json({ ok: false, error: "Unauthorized." });

  // Body
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON body." });
  }

  const {
    title = "",
    body: msgBody = "",
    tokens = [],
    click_action = "/mis-puntos",
    icon,
    badge,
    extraData = {},
    audience // opcional: { docIds: [...] }
  } = body || {};

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).json({ ok: false, error: "Faltan tokens (array con al menos 1 token)." });
  }
  if (!title || !msgBody) {
    return res.status(400).json({ ok: false, error: "Falta title/body." });
  }

  const db = getDb();

  // ====== Generamos notifId (mismo id para todos los destinatarios en este envío) ======
  const notifId = db.collection("_ids").doc().id;

  // ====== DATA para FCM (siempre strings) con el id incluido ======
  const data = asStringRecord({
    id: notifId,
    title,
    body: msgBody,
    click_action,
    icon: icon || process.env.PUSH_ICON_URL || "",
    badge: badge || process.env.PUSH_BADGE_URL || "",
    type: "simple",
    ...extraData, // url, tag, etc.
  });

  const message = { tokens, data }; // ❗️sin notification/webpush.notification

  // LOG (temporal)
  console.log("FCM message about to send:", JSON.stringify({ tokensCount: tokens.length, data }));

  try {
    const adminApp = initFirebaseAdmin();
    const resp = await adminApp.messaging().sendEachForMulticast(message);

    // Limpieza básica: tokens inválidos
    const invalidTokens = [];
    resp.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = r.error?.errorInfo?.code || r.error?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    // ====== TRACKING "sent" en Firestore ======
    let createdInbox = 0;
    try {
      const destinatarios = await resolveDestinatarios({ db, tokens, audience });
      const dataForDoc = {
        title: data.title,
        body:  data.body,
        url:   data.url || data.click_action || "/notificaciones",
        tag:   data.tag || null
      };
      for (const d of destinatarios) {
        try {
          await createInboxSent({ db, clienteId: d.id, notifId, dataForDoc, token: d.token });
          createdInbox++;
        } catch (e) {
          console.error("inbox sent error", d, e?.message || e);
        }
      }
    } catch (e) {
      console.error("resolve destinatarios error:", e?.message || e);
    }

    return res.status(200).json({
      ok: true,
      notifId,
      successCount: resp.successCount,
      failureCount: resp.failureCount,
      invalidTokens,
      createdInbox // cuántos docs "sent" se escribieron
    });
  } catch (err) {
    console.error("FCM send error:", err);
    return res.status(500).json({ ok: false, error: "FCM send error", details: err?.message || String(err) });
  }
}
