// /api/send-notification.js (Vercel runtime "nodejs" – ESM)
export const config = { runtime: 'nodejs' };

// --- Firebase Admin (ESM) ---
import admin from "firebase-admin";

let app;
if (!admin.apps.length) {
  const credJson = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : null;

  app = admin.initializeApp({
    credential: credJson
      ? admin.credential.cert(credJson)
      : admin.credential.applicationDefault(),
  });
} else {
  app = admin.app();
}

const messaging = admin.messaging();

// --- Seguridad: solo llamadas internas (server-to-server) ---
const INTERNAL_TOKEN =
  process.env.API_SECRET_KEY || process.env.MI_API_SECRET || "";

function isAuthorized(req) {
  const raw = (
    req.headers["authorization"] ||
    req.headers["x-api-key"] ||
    ""
  ).toString().replace(/^Bearer\s+/i, "").trim();

  return !!INTERNAL_TOKEN && raw === INTERNAL_TOKEN;
}

// --- Utils ---
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
  // Vercel a veces entrega req.body ya parseado; si no, leemos el stream
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
  for (let i = 0; i < arr.l
