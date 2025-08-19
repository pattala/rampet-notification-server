// /api/programar-lanzamiento.js  (Vercel runtime "nodejs" – ESM)
export const config = { runtime: "nodejs" };

import admin from "firebase-admin";

/* ───────────────────── CORS (única fuente) ───────────────────── */
function parseAllowedOrigins() {
  const raw = (process.env.CORS_ALLOWED_ORIGINS || "").trim();
  return raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];
}
function originAllowed(origin) {
  if (!origin) return false;
  return parseAllowedOrigins().includes(origin);
}
function setCors(res, origin) {
  if (originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, X-API-Key, x-api-key"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

/* ───────────────────── Utilidades JSON ───────────────────── */
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch {}
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const txt = Buffer.concat(chunks).toString("utf8").trim();
  return txt ? JSON.parse(txt) : {};
}

/* ───────────────────── Firebase init (Firestore) ───────────────────── */
let db = null;
try {
  const hasCred = !!process.env.GOOGLE_CREDENTIALS_JSON;
  console.log("[programar-lanzamiento] GOOGLE_CREDENTIALS_JSON present:", hasCred);

  let credJson = null;
  if (hasCred) {
    try { credJson = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); }
    catch (e) { console.error("[programar-lanzamiento] JSON.parse creds:", e?.message); }
  }

  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
        credential: credJson
          ? admin.credential.cert(credJson)
          : admin.credential.applicationDefault(),
      });

  db = admin.firestore(app);
} catch (e) {
  console.error("[programar-lanzamiento] Firebase init error:", e);
}

/* ───────────────────── Constantes ───────────────────── */
const CLIENTS_COLLECTION = process.env.CLIENTS_COLLECTION || "clientes";
const FCM_TOKENS_FIELD  = "fcmTokens";
const API_SECRET_RAW    = process.env.API_SECRET_KEY || process.env.MI_API_SECRET || "";
const API_SECRET        = API_SECRET_RAW.trim();

/* URL absoluta al sender */
// URL absoluta al sender SIEMPRE en PRODUCCIÓN (evita previews protegidos por password)
function buildSendUrl() {
  try {
    const sched = (process.env.NOTIF_SCHEDULER_URL || "").trim();
    if (sched) {
      const base = new URL(sched).origin; // p.ej. https://rampet-notification-server-three.vercel.app
      return `${base}/api/send-notification`;
    }
  } catch {}
  // Fallback explícito al dominio prod
  return "https://rampet-notification-server-three.vercel.app/api/send-notification";
}


/* Construye título/cuerpo desde templateData y, si existe, plantilla Firestore */
async function buildMessage({ templateId, templateData }) {
  let title = templateData?.titulo || "RAMPET";
  let body  = templateData?.descripcion || "";

  try {
    if (db && templateId) {
      const doc = await db.collection("plantillas_mensajes").doc(templateId).get();
      if (doc.exists) {
        const t = doc.data() || {};
        if (t.titulo) {
          title = t.titulo.replace(/\{(\w+)\}/g, (_, k) => String(templateData?.[k] ?? ""));
        }
        if (t.cuerpo) {
          body = t.cuerpo.replace(/\{(\w+)\}/g, (_, k) => String(templateData?.[k] ?? ""));
        }
      }
    }
  } catch (e) {
    console.warn("[programar-lanzamiento] buildMessage plantilla warn:", e?.message);
  }

  return { title, body };
}

/* Obtiene clienteIds por defecto si el panel no manda destinatarios
   ⚠️ Incluye clientes con EMAIL válido o con FCM tokens (emails no dependen de tokens) */
async function collectClienteIdsIfMissing() {
  if (!db) return [];
  const ids = [];
  const isLikelyEmail = (s) =>
    typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

  try {
    const snap = await db.collection(CLIENTS_COLLECTION).get();
    snap.forEach(doc => {
      const data = doc.data() || {};
      const tokens = Array.isArray(data[FCM_TOKENS_FIELD]) ? data[FCM_TOKENS_FIELD] : [];
      const hasTokens = tokens.length > 0;
      const hasEmail  = isLikelyEmail(data.email);
      if (hasTokens || hasEmail) ids.push(doc.id);
    });
  } catch (e) {
    console.error("[programar-lanzamiento] collectClienteIdsIfMissing error:", e?.message || e);
  }
  return ids;
}

/* Recolecta destinatarios por defecto desde Firestore (tokens + emails + ids) */
async function collectRecipientsDefault() {
  const result = { tokens: [], emails: [], clienteIds: [] };
  if (!db) return result;

  const isLikelyEmail = (s) =>
    typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s?.trim());

  const tokenSet = new Set();
  const emailSet = new Set();
  const ids = [];

  try {
    const snap = await db.collection(CLIENTS_COLLECTION).get();
    snap.forEach(doc => {
      const data = doc.data() || {};

      ids.push(doc.id);

      const arr = Array.isArray(data[FCM_TOKENS_FIELD]) ? data[FCM_TOKENS_FIELD] : [];
      arr.forEach(t => { if (typeof t === "string" && t.trim()) tokenSet.add(t.trim()); });

      if (isLikelyEmail(data.email)) emailSet.add(String(data.email).trim());
    });
  } catch (e) {
    console.error("[programar-lanzamiento] collectRecipientsDefault error:", e?.message || e);
  }

  result.tokens = Array.from(tokenSet);
  result.emails = Array.from(emailSet);
  result.clienteIds = ids;
  return result;
}

/* ───────────────────── Handler ───────────────────── */
export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  setCors(res, origin);
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    if (!originAllowed(origin)) return res.status(403).end();
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!originAllowed(origin)) {
    return res.status(403).json({ ok: false, error: "Origin not allowed" });
  }

  try {
    const payload = await readJson(req);

    // Lo que manda el panel:
    // { campaignId, tipoNotificacion, templateId, templateData, fechaNotificacion, ... }
    const {
      campaignId,
      tipoNotificacion,     // "lanzamiento" => enviar ahora
      templateId,
      templateData = {},
      fechaNotificacion,    // ignorada si es inmediato
      tokens,               // opcional
      clienteIds,           // opcional
      emails,               // opcional
      data                  // opcional
    } = payload || {};

    // 1) Armar mensaje
    const { title, body } = await buildMessage({ templateId, templateData });

    // 2) Resolver destinatarios con fallbacks
    let clienteIdsToUse = Array.isArray(clienteIds) ? clienteIds.filter(Boolean) : [];
    let tokensToUse     = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
    let emailsToUse     = Array.isArray(emails) ? emails.filter(Boolean) : [];

    if (tokensToUse.length === 0 && clienteIdsToUse.length === 0) {
      clienteIdsToUse = await collectClienteIdsIfMissing();
    }
    if (tokensToUse.length === 0 && clienteIdsToUse.length === 0 && emailsToUse.length === 0) {
      const rec = await collectRecipientsDefault();
      tokensToUse     = rec.tokens;
      emailsToUse     = rec.emails;
      clienteIdsToUse = rec.clienteIds;
    }

    // 3) Payload para el sender
    const senderPayload = {
      title,
      body,
      ...(tokensToUse.length ? { tokens: tokensToUse } : {}),
      ...(clienteIdsToUse.length ? { clienteIds: clienteIdsToUse } : {}),
      ...(emailsToUse.length ? { emails: emailsToUse } : {}),
      data: {
        campaignId: campaignId || templateData?.campaignId || "",
        tipoNotificacion: tipoNotificacion || "lanzamiento",
        templateId: templateId || "",
        ...(data || {})
      }
    };

    // 4) Reenvío server-to-server al sender con auth
    if (!API_SECRET) {
      console.error("[programar-lanzamiento] Missing API_SECRET_KEY env");
      return res.status(500).json({ ok: false, error: "Missing API_SECRET_KEY on server" });
    }

    const url = buildSendUrl();
    // Log mínimo para diagnosticar (sin exponer secretos)
    console.log("[programar-lanzamiento][auth] secret_present:", !!API_SECRET, "len:", API_SECRET.length, "url:", url);

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Enviamos ambos encabezados por robustez
        "Authorization": `Bearer ${API_SECRET}`,
        "x-api-key": API_SECRET,
      },
      body: JSON.stringify(senderPayload),
    });

    const txt = await r.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }

    return res.status(200).json({
      ok: true,
      result: {
        ok: r.ok,
        schedulerStatus: r.status,
        ...json, // incluye successCount/failureCount/invalidTokens/cleanedDocs/emails si el sender responde eso
      },
    });
  } catch (e) {
    console.error("[programar-lanzamiento] error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
