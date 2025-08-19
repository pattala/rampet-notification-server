// /api/programar-lanzamiento.js  (Vercel runtime "nodejs" – ESM)
export const config = { runtime: "nodejs" };

import admin from "firebase-admin";

// ───────────────────── CORS (única fuente) ─────────────────────
function parseAllowedOrigins() {
  const raw = (process.env.CORS_ALLOWED_ORIGINS || "").trim();
  return raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];
}

function originAllowed(origin) {
  if (!origin) return false;
  const allowed = parseAllowedOrigins();
  return allowed.includes(origin);
}

function setCors(res, origin) {
  if (originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, X-API-Key"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ───────────────────── Utilidades JSON ─────────────────────
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

// ───────────────────── Firebase init (Firestore) ─────────────────────
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

// ───────────────────── Constantes ─────────────────────
const CLIENTS_COLLECTION = process.env.CLIENTS_COLLECTION || "clientes";
const FCM_TOKENS_FIELD  = "fcmTokens";
const API_SECRET        = process.env.API_SECRET_KEY || process.env.MI_API_SECRET || "";

// URL absoluta al sender (misma app en Vercel, con fallback a tu dominio)
function buildSendUrl() {
  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  const fallback  = "https://rampet-notification-server-three.vercel.app";
  const base      = vercelUrl || fallback;
  return `${base}/api/send-notification`;
}

// Construye título/cuerpo desde templateData y, si existe, plantilla Firestore
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

// Obtiene clienteIds por defecto si el panel no manda destinatarios
// ⚠️ Incluye clientes con EMAIL válido o con FCM tokens (emails no dependen de tokens)
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

// Recolecta destinatarios por defecto desde Firestore (tokens + emails + ids)
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

      // id del cliente
      ids.push(doc.id);

      // Tokens
      const arr = Array.isArray(data[FCM_TOKENS_FIELD]) ? data[FCM_TOKENS_FIELD] : [];
      arr.forEach(t => { if (typeof t === "string" && t.trim()) tokenSet.add(t.trim()); });

      // Email
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

// ───────────────────── Handler ─────────────────────
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

    // Lo que manda el panel hoy (según tu captura):
    // { campaignId, tipoNotificacion, templateId, templateData, fechaNotificacion }
    const {
      campaignId,
      tipoNotificacion,     // "lanzamiento" => enviar ahora
      templateId,
      templateData = {},
      fechaNotificacion,    // no se usa si es inmediata
      tokens,               // opcional: si el panel los manda
      clienteIds,           // opcional: si el panel los manda
      emails,               // opcional: si el panel los manda
      data                  // opcional: data extra
    } = payload || {};

    // 1) Armar mensaje
    const { title, body } = await buildMessage({ templateId, templateData });

    // 2) Resolver destinatarios (con fallbacks)
    let clienteIdsToUse = Array.isArray(clienteIds) ? clienteIds.filter(Boolean) : [];
    let tokensToUse     = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
    let emailsToUse     = Array.isArray(emails) ? emails.filter(Boolean) : [];

    // 1er fallback: si no vinieron tokens ni clienteIds, armamos clienteIds por defecto
    if (tokensToUse.length === 0 && clienteIdsToUse.length === 0) {
      clienteIdsToUse = await collectClienteIdsIfMissing();
    }

    // 2do fallback (último recurso): si sigue TODO vacío (tokens, ids y emails),
    // juntamos DIRECTAMENTE tokens + emails + ids desde Firestore.
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
      return res.status(500).json({
        ok: false,
        error: "Missing API_SECRET_KEY on server",
      });
    }

    const url = buildSendUrl();
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

    const json = await r.json().catch(() => ({}));
    return res.status(200).json({
      ok: true,
      result: {
        ok: r.ok,
        schedulerStatus: r.status,
        ...json, // incluye successCount/failureCount/invalidTokens/cleanedDocs/emails
      },
    });
  } catch (e) {
    console.error("[programar-lanzamiento] error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
