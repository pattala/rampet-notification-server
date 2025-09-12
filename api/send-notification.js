// /api/send-notification.js
// Envío de notificaciones FCM en modo "data-only" + TRACKING "sent" por usuario.
//
// Env vars (Vercel):
// - GOOGLE_CREDENTIALS_JSON
// - API_SECRET_KEY
// - CORS_ALLOWED_ORIGINS ("https://rampet.vercel.app,http://127.0.0.1:5500")
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

// ---------- Resolución de destinatarios ----------
async function resolveDestinatarios({ db, tokens = [], audience, clienteId }) {
  let destinatarios = [];

  // 1) Audience explícito (campañas con docIds)
  if (audience && Array.isArray(audience.docIds) && audience.docIds.length) {
    destinatarios = audience.docIds.map(id => ({ id }));
  }

  // 2) Caso "uno"
  if (!destinatarios.length && clienteId) {
    destinatarios.push({ id: clienteId });
  }

  // 3) Mapear token -> cliente (por fcmTokens)
  if (!destinatarios.length && Array.isArray(tokens) && tokens.length) {
    for (const tkRaw of tokens) {
      const tk = String(tkRaw || "").trim();
      if (!tk) continue;
      const q = await db.collection("clientes")
        .where("fcmTokens", "array-contains", tk)
        .limit(1).get();
      if (!q.empty) {
        destinatarios.push({ id: q.docs[0].id, token: tk });
      } else {
        console.warn("⚠️ Token sin cliente asociado:", tk);
      }
    }
  }

  // 4) De-dup por clienteId
  const seen = new Set();
  return destinatarios.filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
}

// ---------- Tracking en Inbox ----------
async function createInboxSent({ db, clienteId, notifId, dataForDoc, token }) {
  const ref = db.collection("clientes").doc(clienteId).collection("inbox").doc(notifId);
  await ref.set({
    title:  dataForDoc.title || "",
    body:   dataForDoc.body  || "",
    url:    dataForDoc.url   || "/notificaciones",
    tag:    dataForDoc.tag   || null,
    source: dataForDoc.source || "simple",
    campaignId: dataForDoc.campaignId || null,
    token:  token || null,
    status: "sent",
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
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
    title = "",
    body: msgBody = "",
    tokens: tokensIn = [],
    click_action = "/mis-puntos",
    icon,
    badge,
    extraData = {},           // { url, tag, source, campaignId, ... }
    audience,                 // { docIds: [...] }
    clienteId,                // cuando es "uno"
  } = body || {};

  if (!title || !msgBody) {
    return res.status(400).json({ ok: false, error: "Falta title/body." });
  }

  const db = getDb();

  // ====== Resolver tokens (entrada) ======
  let tokens = (Array.isArray(tokensIn) ? tokensIn : [])
    .map(t => String(t || "").trim())
    .filter(Boolean);
  tokens = Array.from(new Set(tokens));

  // Si no trajeron tokens pero mandan clienteId → obtenemos los del cliente
  if (!tokens.length && clienteId) {
    try {
      const snap = await db.collection("clientes").doc(String(clienteId)).get();
      const dataC = snap.exists ? snap.data() : null;
      const fromCliente = Array.isArray(dataC?.fcmTokens) ? dataC.fcmTokens : [];
      tokens = Array.from(new Set(fromCliente.map(t => String(t || "").trim()).filter(Boolean)));
    } catch (e) {
      console.error("Error resolviendo tokens por clienteId:", e?.message || e);
    }
  }

  if (!tokens.length) {
    return res.status(400).json({ ok: false, error: "Faltan tokens (array con al menos 1 token)." });
  }

  // ====== notifId (único para este envío) ======
  const notifId = db.collection("_ids").doc().id;

  // ====== DATA para FCM (strings) ======
  const data = asStringRecord({
    id: notifId,
    title,
    body: msgBody,
    click_action,
    url: (extraData && extraData.url) ? extraData.url : click_action,
    icon:  icon  || process.env.PUSH_ICON_URL  || "",
    badge: badge || process.env.PUSH_BADGE_URL || "",
    type: "simple",
    ...extraData,
  });

  // ====== Mensaje FCM (DATA-ONLY) ======
  // (El SW muestra la notificación; evitamos el bloque "notification" para no chocar con validaciones)
  const message = {
    tokens,
    data,
    webpush: {
      fcmOptions: { link: data.url || "/notificaciones" },
      headers: { TTL: "2419200" } // 28 días
    }
  };

  console.log("FCM message about to send:", JSON.stringify({ tokensCount: tokens.length, data }));

  try {
    const adminApp = initFirebaseAdmin();
    const resp = await adminApp.messaging().sendEachForMulticast(message);

    const perToken = resp.responses.map((r, i) => ({
      index: i,
      token: tokens[i],
      success: r.success,
      errorCode: r.error?.code || r.error?.errorInfo?.code || null,
      errorMessage: r.error?.message || null,
    }));
    console.log("FCM per-token:", perToken);

    // Tokens inválidos → limpiar en Firestore
    const invalidTokens = [];
    resp.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = r.error?.errorInfo?.code || r.error?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    if (invalidTokens.length) {
      try {
        // Firestore sólo permite hasta 10 en array-contains-any; troceamos por las dudas
        const chunks = [];
        for (let i = 0; i < invalidTokens.length; i += 10) {
          chunks.push(invalidTokens.slice(i, i + 10));
        }
        for (const part of chunks) {
          const snap = await db.collection("clientes")
            .where("fcmTokens", "array-contains-any", part)
            .get();
          for (const doc of snap.docs) {
            const d = doc.data();
            const nuevos = (d.fcmTokens || []).filter(tk => !invalidTokens.includes(tk));
            await doc.ref.update({ fcmTokens: nuevos });
            console.log(`🧹 Tokens inválidos eliminados de clientes/${doc.id}`);
          }
        }
      } catch (cleanErr) {
        console.error("Error limpiando tokens inválidos:", cleanErr);
      }
    }

    // Tracking "sent" en Firestore para TODOS los destinatarios resueltos
    let createdInbox = 0;
    try {
      const destinatarios = await resolveDestinatarios({ db, tokens, audience, clienteId });
      console.log("🔍 Destinatarios resueltos:", destinatarios);

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
      createdInbox,
      perToken, // detalle por token
    });
  } catch (err) {
    console.error("FCM send error:", err);
    return res.status(500).json({ ok: false, error: "FCM send error", details: err?.message || String(err) });
  }
}
