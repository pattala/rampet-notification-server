// /api/programar-lanzamiento.js  (Vercel runtime "nodejs" – ESM)
export const config = { runtime: "nodejs" };

import admin from "firebase-admin";

// ────────────── CORS helpers (1 sola fuente en este archivo) ──────────────
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
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ────────────── JSON utils ──────────────
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

// ────────────── Firebase init (solo Firestore, sin duplicar app) ──────────────
let db = null;
try {
  const hasCred = !!process.env.GOOGLE_CREDENTIALS_JSON;
  let credJson = null;
  if (hasCred) {
    try { credJson = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); } catch (e) {
      console.error("[programar-lanzamiento] GOOGLE_CREDENTIALS_JSON parse:", e?.message);
    }
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

// ────────────── Config / constantes ──────────────
const CLIENTS_COLLECTION = process.env.CLIENTS_COLLECTION || "clientes";
const FCM_TOKENS_FIELD  = "fcmTokens";
const API_SECRET        = process.env.API_SECRET_KEY || process.env.MI_API_SECRET || "";

// URL absoluta al sender
function buildSendUrl() {
  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  const fallback  = "https://rampet-notification-server-three.vercel.app";
  const base      = vercelUrl || fallback;
  return `${base}/api/send-notification`;
}

// Crea title/body desde templateData o plantilla Firestore (fallback simple)
async function buildMessage({ templateId, templateData }) {
  // Fallback directo desde templateData (lo que ya manda el panel)
  let title = templateData?.titulo || "RAMPET";
  let body  = templateData?.descripcion || "";

  // Si querés usar plantillas Firestore:
  // Colección: plantillas_mensajes  |  IDs: nueva_campana, recordatorio_campana, etc.
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

// Obtiene clienteIds para envío (si el panel no los manda)
// Incluye clientes con EMAIL válido o con FCM tokens.
// Así, si no hay tokens, igual se envían los emails.
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


// ────────────── Handler ──────────────
export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  setCors(res, origin);

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
    const body = await readJson(req);

    // Lo que hoy envía el panel (tu captura):
    // { campaignId, tipoNotificacion, templateId, templateData, fechaNotificacion }
    const {
      campaignId,
      tipoNotificacion,     // "lanzamiento" => enviar ahora
      templateId,
      templateData = {},
      fechaNotificacion,    // no lo usamos si es "inmediata"
      tokens,               // si alguna vez el panel los manda, se respetan
      clienteIds,           // idem
      emails,               // idem
      data                  // datos extra opcionales
    } = body || {};

    // 1) Armar mensaje
    const { title, body: msgBody } = await buildMessage({ templateId, templateData });

    // 2) Decidir destinatarios
    let clienteIdsToUse = Array.isArray(clienteIds) ? clienteIds.filter(Boolean) : [];
    if ((!tokens || tokens.length === 0) && clienteIdsToUse.length === 0) {
      // Si el panel no mandó nada, buscamos TODOS los clientes con fcmTokens
      clienteIdsToUse = await collectClienteIdsIfMissing();
    }

    // 3) Construir payload para el sender (tiene fallback a clienteIds → tokens)
    const senderPayload = {
      title,
      body: msgBody,
      // si el panel envía tokens, se usan; si no, el sender deduce por clienteIds
      ...(Array.isArray(tokens) && tokens.length ? { tokens } : {}),
      ...(Array.isArray(clienteIdsToUse) && clienteIdsToUse.length ? { clienteIds: clienteIdsToUse } : {}),
      ...(Array.isArray(emails) && emails.length ? { emails } : {}),
      data: {
        campaignId: campaignId || templateData?.campaignId || "",
        tipoNotificacion: tipoNotificacion || "lanzamiento",
        templateId: templateId || "",
        ...(data || {})
      }
    };

    // 4) Reenvío server-to-server al sender
    const url = buildSendUrl();
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Auth interna para el sender:
        "Authorization": `Bearer ${API_SECRET}`,
      },
      body: JSON.stringify(senderPayload),
    });

    const json = await r.json().catch(() => ({}));
    return res.status(200).json({
      ok: true,
      result: {
        ok: r.ok,
        schedulerStatus: r.status,
        ...json, // incluye successCount/failureCount/invalidTokens/emails/cleanedDocs
      },
    });
  } catch (e) {
    console.error("[programar-lanzamiento] error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
