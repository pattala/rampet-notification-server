// /api/send-notification.js (Vercel runtime "nodejs" – ESM)
export const config = { runtime: 'nodejs' };

// ───────────────── Firebase Admin (ESM) ─────────────────
import admin from "firebase-admin";

let messaging;
let firebaseInitError = null;

try {
  let app;

  // Log mínimo (sin secretos)
  const hasCred = !!process.env.GOOGLE_CREDENTIALS_JSON;
  console.log("[send-notification] GOOGLE_CREDENTIALS_JSON present:", hasCred);

  let credJson = null;
  if (hasCred) {
    try {
      credJson = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    } catch (e) {
      console.error("[send-notification] GOOGLE_CREDENTIALS_JSON JSON.parse failed:", e?.message);
      // Seguimos con credJson = null para intentar Application Default
    }
  }

  if (!admin.apps.length) {
    app = admin.initializeApp({
      credential: credJson
        ? admin.credential.cert(credJson)
        : admin.credential.applicationDefault(),
    });
  } else {
    app = admin.app();
  }

  messaging = admin.messaging(app);
} catch (e) {
  firebaseInitError = e;
  console.error("[send-notification] Firebase init error:", e);
}

// ───────────────── Seguridad (solo server-to-server) ─────────────────
const INTERNAL_TOKEN = process.env.API_SECRET_KEY || process.env.MI_API_SECRET || "";

function isAuthorized(req) {
  const raw = (
    req.headers["authorization"] ||
    req.headers["x-api-key"] ||
    ""
  ).toString().replace(/^Bearer\s+/i, "").trim();

  return !!INTERNAL_TOKEN && raw === INTERNAL_TOKEN;
}

// ───────────────── Utilidades ─────────────────
function pick(v, fallback) {
  return v !== undefined && v !== null && v !== "" ? v : fallback;
}

function buildWebpushPayload({ title, body, icon, badge, link }) {
  const finalIcon = pick(icon, process.env.PUSH_ICON_URL || undefined);
  const finalBadge = pick(badge, process.env.PUSH_BADGE_URL || undefined);
  const finalLink = pick(link, process.env.PWA_URL || undefined);

  const notification = {
    title: String(title || "Notificación"),
    body: String(body || ""),
    ...(finalIcon ? { icon: finalIcon } : {}),
    ...(finalBadge ? { badge: finalBadge } : {}),
  };

  const webpush = {
    notification,
    ...(finalLink ? { fcmOptions: { link: finalLink } } : {}),
  };

  return webpush;
}

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

function toStringData(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

// ───────────────── Handler ─────────────────
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (firebaseInitError || !messaging) {
    return res.status(500).json({
      ok: false,
      error: "Firebase init failed",
      hint: "Revisá GOOGLE_CREDENTIALS_JSON en Vercel. Debe ser el JSON completo del Service Account.",
      detail: String(firebaseInitError?.message || firebaseInitError || "Unknown"),
    });
  }

  try {
    const body = await readJson(req);

    // Estructura esperada:
    // {
    //   tokens?: string[],    // preferido
    //   topic?: string,       // opcional
    //   title?: string,
    //   body?: string,
    //   icon?: string,
    //   badge?: string,
    //   link?: string,
    //   data?: Record<string,string|number|...>
    // }
    const {
      tokens = [],
      topic,
      title,
      body: nBody,
      icon,
      badge,
      link,
      data = {},
    } = body || {};

    const webpush = buildWebpushPayload({ title, body: nBody, icon, badge, link });
    const safeData = toStringData(data);

    // Envío por topic
    if (topic && (!tokens || tokens.length === 0)) {
      const msg = {
        topic,
        webpush,
        ...(Object.keys(safeData).length ? { data: safeData } : {}),
      };
      const messageId = await messaging.send(msg, false);
      return res.status(200).json({ ok: true, mode: "topic", messageId });
    }

    // Envío por tokens
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ ok: false, error: "Faltan tokens o topic" });
    }

    // FCM permite hasta 500 por lote
    const batches = chunk(tokens, 500);
    let success = 0, failure = 0;
    const invalidTokens = [];

    for (const tk of batches) {
      const msg = {
        tokens: tk,
        webpush,
        ...(Object.keys(safeData).length ? { data: safeData } : {}),
      };
      const r = await messaging.sendEachForMulticast(msg);

      success += r.successCount;
      failure += r.failureCount;

      r.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code || "";
          if (
            code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-argument"
          ) {
            invalidTokens.push(tk[idx]);
          }
        }
      });
    }

    return res.status(200).json({
      ok: true,
      mode: "multicast",
      successCount: success,
      failureCount: failure,
      invalidTokens,
    });
  } catch (err) {
    console.error("send-notification error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
