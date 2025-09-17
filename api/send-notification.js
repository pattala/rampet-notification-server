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

// ---------- Utils ----------
function unique(arr = []) {
  return [...new Set((arr || []).filter(Boolean).map(s => String(s).trim()).filter(Boolean))];
}
function chunkArray(arr = [], size = 500) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function isInvalidTokenError(code = "") {
  return code.includes("registration-token-not-registered")
      || code.includes("invalid-registration-token")
      || code.includes("messaging/registration-token-not-registered")
      || code.includes("messaging/invalid-registration-token")
      || code.includes("invalid-argument"); // Admin SDK puede mapear así
}

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
// Devuelve una lista de { id: clienteId, token } (uno por token).
async function resolveDestinatarios({ db, tokens = [], audience, clienteId }) {
  const out = [];

  // Helper: trae tokens de una lista de docIds (en lotes de 10 por límite de IN)
  async function fetchDocIds(docIds) {
    const ids = docIds.map(String).filter(Boolean);
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      const snap = await db.collection("clientes")
        .where(admin.firestore.FieldPath.documentId(), "in", batch)
        .get();
      snap.forEach(doc => {
        const data = doc.data() || {};
        const toks = Array.isArray(data.fcmTokens) ? data.fcmTokens : [];
        toks.forEach(tk => {
          const clean = String(tk || "").trim();
          if (clean) out.push({ id: doc.id, token: clean });
        });
      });
    }
  }

  // 1) Audience explícito (campañas con docIds)
  if (audience && Array.isArray(audience.docIds) && audience.docIds.length) {
    await fetchDocIds(audience.docIds);
  }

  // 2) Caso "uno"
  if (clienteId) {
    const snap = await db.collection("clientes").doc(String(clienteId)).get();
    if (snap.exists) {
      const data = snap.data() || {};
      const toks = Array.isArray(data.fcmTokens) ? data.fcmTokens : [];
      toks.forEach(tk => {
        const clean = String(tk || "").trim();
        if (clean) out.push({ id: snap.id, token: clean });
      });
    }
  }

  // 3) Mapear token -> cliente (por fcmTokens)
  if (Array.isArray(tokens) && tokens.length) {
    for (const tkRaw of tokens) {
      const tk = String(tkRaw || "").trim();
      if (!tk) continue;
      const q = await db.collection("clientes")
        .where("fcmTokens", "array-contains", tk)
        .limit(1).get();
      if (!q.empty) {
        out.push({ id: q.docs[0].id, token: tk });
      } else {
        console.warn("⚠️ Token sin cliente asociado:", tk);
      }
    }
  }

  // De-dup por combinación (clienteId + token)
  const seen = new Set();
  return out.filter(d => {
    const key = `${d.id}|${d.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- Tracking en Inbox ----------
// Crea/mergea el doc en clientes/{clienteId}/inbox/{notifId}. Si viene token, lo guarda.
async function createInboxSent({ db, clienteId, notifId, dataForDoc, token }) {
  const ref = db.collection("clientes").doc(clienteId).collection("inbox").doc(notifId);
  const base = {
    title:  dataForDoc.title || "",
    body:   dataForDoc.body  || "",
    url:    dataForDoc.url   || "/notificaciones",
    tag:    dataForDoc.tag   || null,
    source: dataForDoc.source || "simple",
    campaignId: dataForDoc.campaignId || null,
    status: "sent",
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    expireAt: admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    ),
  };
  if (token) base.token = token; // no sobreescribimos con null
  await ref.set(base, { merge: true });
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

  // ====== Normalizar tokens de entrada ======
  let tokens = unique(tokensIn);

  // Si no trajeron tokens pero mandan clienteId → obtenemos los del cliente
  if (!tokens.length && clienteId) {
    try {
      const snap = await db.collection("clientes").doc(String(clienteId)).get();
      const dataC = snap.exists ? snap.data() : null;
      const fromCliente = Array.isArray(dataC?.fcmTokens) ? dataC.fcmTokens : [];
      tokens = unique(fromCliente);
    } catch (e) {
      console.error("Error resolviendo tokens por clienteId:", e?.message || e);
    }
  }

  // ====== Resolver destinatarios para enviar y para tracking ======
  // (Incluye audience.docIds → ahora SÍ se usan para ENVIAR)
  let destinatarios = [];
  try {
    destinatarios = await resolveDestinatarios({ db, tokens, audience, clienteId });
  } catch (e) {
    console.error("resolveDestinatarios error:", e?.message || e);
  }

  // Tokens para envío = tokens de entrada (si hay) + tokens resueltos por audience/cliente
  let sendTokens = unique([ ...tokens, ...destinatarios.map(d => d.token) ]);

  if (!sendTokens.length) {
    return res.status(400).json({ ok: false, error: "Faltan tokens o audience.docIds." });
  }

  // ====== notifId (único por envío) ======
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

  // Config común a todos los lotes
  const baseMsg = {
    data,
    webpush: {
      fcmOptions: { link: data.url || "/notificaciones" },
      headers: { TTL: "2419200" } // 28 días
    }
  };

  console.log("FCM about to send:", JSON.stringify({ tokensCount: sendTokens.length, withAudience: !!(audience?.docIds?.length) }));

  // ====== Envío en lotes (≤500) ======
  const adminApp = initFirebaseAdmin();
  const batches = chunkArray(sendTokens, 500);

  let successCount = 0, failureCount = 0;
  const invalidTokens = new Set();
  const perToken = []; // { token, success, errorCode, errorMessage }

  for (const batchTokens of batches) {
    const message = { ...baseMsg, tokens: batchTokens };
    const resp = await adminApp.messaging().sendEachForMulticast(message);

    successCount += resp.successCount || 0;
    failureCount += resp.failureCount || 0;

    (resp.responses || []).forEach((r, idx) => {
      const t = batchTokens[idx];
      const code = r.error?.errorInfo?.code || r.error?.code || null;
      if (!r.success && code && isInvalidTokenError(code)) invalidTokens.add(t);

      perToken.push({
        token: t,
        success: !!r.success,
        errorCode: code,
        errorMessage: r.error?.message || null,
      });
    });
  }

  // ====== Limpieza de tokens inválidos en Firestore ======
  if (invalidTokens.size) {
    try {
      const toClean = Array.from(invalidTokens);
      for (let i = 0; i < toClean.length; i += 10) {
        const part = toClean.slice(i, i + 10);
        const snap = await db.collection("clientes")
          .where("fcmTokens", "array-contains-any", part)
          .get();
        for (const doc of snap.docs) {
          const d = doc.data() || {};
          const nuevos = (d.fcmTokens || []).filter(tk => !toClean.includes(tk));
          await doc.ref.update({ fcmTokens: nuevos });
          console.log(`🧹 Tokens inválidos eliminados de clientes/${doc.id}`);
        }
      }
    } catch (cleanErr) {
      console.error("Error limpiando tokens inválidos:", cleanErr);
    }
  }

  // ====== Tracking "sent" en Firestore (1 doc por cliente) ======
  // Si algunos tokens no tenían cliente mapeado, igual se enviaron,
  // pero acá sólo creamos inbox para los que sí mapean a clienteId.
  let createdInbox = 0;
  try {
    const dataForDoc = {
      title: data.title,
      body:  data.body,
      url:   data.url || data.click_action || "/notificaciones",
      tag:   data.tag || null,
      source: extraData?.source || "simple",
      campaignId: extraData?.campaignId || null,
    };

    // Colapsar por cliente (primer token)
    const byClient = new Map();
    destinatarios.forEach(d => {
      if (!byClient.has(d.id)) byClient.set(d.id, d.token || null);
    });

    for (const [cid, anyToken] of byClient.entries()) {
      try {
        await createInboxSent({ db, clienteId: cid, notifId, dataForDoc, token: anyToken });
        createdInbox++;
      } catch (e) {
        console.error("inbox sent error", { cid, anyToken }, e?.message || e);
      }
    }
  } catch (e) {
    console.error("resolve destinatarios (tracking) error:", e?.message || e);
  }

  return res.status(200).json({
    ok: true,
    notifId,
    successCount,
    failureCount,
    invalidTokens: Array.from(invalidTokens),
    createdInbox,
    perToken
  });
}
