// /api/send-notification.js
// Envío de notificaciones FCM con 'notification' + 'data' y TRACKING "sent" por usuario.
//
// Env vars requeridas (Vercel):
// - GOOGLE_CREDENTIALS_JSON  (service account JSON completo)
// - API_SECRET_KEY           (clave que compara con header x-api-key)
// - CORS_ALLOWED_ORIGINS     (lista separada por coma, ej: "https://rampet.vercel.app,http://127.0.0.1:5500")
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

// ---------- Utilidades CORS / Auth ----------
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

// ---------- Helpers TRACKING ----------
async function resolveDestinatarios({ db, tokens = [], audience, clienteId }) {
  // Preferimos audience.docIds si viene desde el Panel/Campañas
  let destinatarios = [];
  if (audience && Array.isArray(audience.docIds) && audience.docIds.length) {
    destinatarios = audience.docIds.map(id => ({ id }));
  }

  // Caso directo "uno": si viene clienteId explícito
  if (!destinatarios.length && clienteId) {
    destinatarios.push({ id: clienteId });
  }

  // Si no hay audience ni clienteId, mapeamos token -> cliente por fcmTokens
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
    title:  dataForDoc.title || "",
    body:   dataForDoc.body  || "",
    url:    dataForDoc.url   || "/notificaciones",
    tag:    dataForDoc.tag   || null,
    source: dataForDoc.source || "simple",   // en campañas: "campania"
    campaignId: dataForDoc.campaignId || null,
    token:  token || null,
    status: "sent",
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    // TTL de 90 días para mantener la bandeja ligera
    expireAt: admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    ),
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
    // contrato base
    title = "",
    body: msgBody = "",
    tokens: tokensIn = [],
    click_action = "/mis-puntos",
    icon,
    badge,
    extraData = {},           // puede incluir { url, tag, ... }
    audience,                 // opcional: { docIds: [...] }
    // extensiones
    clienteId,                // cuando es "uno"
  } = body || {};

  if (!title || !msgBody) {
    return res.status(400).json({ ok: false, error: "Falta title/body." });
  }

  const db = getDb();

  // ====== Resolver tokens ======
  let tokens = Array.isArray(tokensIn) ? [...tokensIn] : [];
  // Si no trajeron tokens pero trajeron clienteId, buscamos los del cliente
  if ((!tokens || tokens.length === 0) && clienteId) {
    try {
      const snap = await db.collection("clientes").doc(String(clienteId)).get();
      const data = snap.exists ? snap.data() : null;
      const fromCliente = Array.isArray(data?.fcmTokens) ? data.fcmTokens : [];
      tokens = fromCliente.filter(Boolean);
    } catch (e) {
      console.error("Error resolviendo tokens por clienteId:", e?.message || e);
    }
  }
  // Normalizar + de-dup
  tokens = (Array.isArray(tokens) ? tokens : []).map(String).filter(Boolean);
  tokens = Array.from(new Set(tokens));

  if (!tokens.length) {
    return res.status(400).json({ ok: false, error: "Faltan tokens (array con al menos 1 token)." });
  }

  // ====== notifId (único para este envío) ======
  const notifId = db.collection("_ids").doc().id;

  // ====== DATA para FCM (siempre strings) con el id ======
  const data = asStringRecord({
    id: notifId,
    title,
    body: msgBody,
    click_action,
    url: (extraData && extraData.url) ? extraData.url : click_action, // guardamos ambos por compat
    icon:  icon  || process.env.PUSH_ICON_URL  || "",
    badge: badge || process.env.PUSH_BADGE_URL || "",
    type: "simple",
    ...extraData, // ej: { tag: "...", url: "..." }
  });

  // ====== Mensaje FCM ======
  const message = {
    tokens,
    // Agregamos bloque notification para forzar visualización en todos los estados
    notification: {
      title,
      body: msgBody,
      icon: data.icon || 'https://rampet.vercel.app/images/mi_logo_192.png',
    },
    data, // mantenemos data para el SW (postMessage, tracking, etc.)
    webpush: {
      fcmOptions: {
        link: data.url || "/notificaciones", // abre la URL si no hay SW que intercepte
      },
      headers: {
        // Opcional: mejorar entrega
        TTL: "2419200" // 28 días
      }
    }
  };

  // LOG (temporal)
  console.log("FCM message about to send:", JSON.stringify({ tokensCount: tokens.length, data }));

  try {
    const adminApp = initFirebaseAdmin();
    const resp = await adminApp.messaging().sendEachForMulticast(message);

    // Tokens inválidos → sugerimos limpiar
    const invalidTokens = [];
    resp.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = r.error?.errorInfo?.code || r.error?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    // Tracking "sent" en Firestore
    let createdInbox = 0;
    try {
      const destinatarios = await resolveDestinatarios({ db, tokens, audience, clienteId });
      const dataForDoc = {
        title: data.title,
        body:  data.body,
        url:   data.url || data.click_action || "/notificaciones",
        tag:   data.tag || null,
        source: extraData?.source || "simple",
        campaignId: extraData?.campaignId || null,
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
      createdInbox
    });
  } catch (err) {
    console.error("FCM send error:", err);
    return res.status(500).json({ ok: false, error: "FCM send error", details: err?.message || String(err) });
  }
}
