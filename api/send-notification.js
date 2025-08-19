// /api/send-notification.js  (Vercel runtime "nodejs" – ESM)
export const config = { runtime: "nodejs" };

import admin from "firebase-admin";
import sgMail from "@sendgrid/mail";

// ────────────── CORS ──────────────
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

// ────────────── JSON utils ──────────────
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch {}
  }
  const bufs = [];
  for await (const c of req) bufs.push(c);
  const txt = Buffer.concat(bufs).toString("utf8").trim();
  return txt ? JSON.parse(txt) : {};
}

// ────────────── Firebase init ──────────────
let db = null, messaging = null;
try {
  const hasCred = !!process.env.GOOGLE_CREDENTIALS_JSON;
  console.log("[send-notification] GOOGLE_CREDENTIALS_JSON present:", hasCred);

  let credJson = null;
  if (hasCred) {
    try { credJson = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); }
    catch (e) { console.error("[send-notification] JSON.parse creds:", e?.message); }
  }

  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
        credential: credJson
          ? admin.credential.cert(credJson)
          : admin.credential.applicationDefault(),
      });

  db = admin.firestore(app);
  messaging = admin.messaging(app);
} catch (e) {
  console.error("[send-notification] Firebase init error:", e);
}

// ────────────── Constantes / helpers ──────────────
const CLIENTS_COLLECTION = process.env.CLIENTS_COLLECTION || "clientes";
const FCM_TOKENS_FIELD  = "fcmTokens";

const API_SECRET_RAW = (process.env.API_SECRET_KEY || process.env.MI_API_SECRET || "");
const API_SECRET     = API_SECRET_RAW.trim();  // <= TRIM MUY IMPORTANTE

const PWA_URL    = process.env.PWA_URL || "https://rampet.vercel.app";
const PUSH_ICON  = process.env.PUSH_ICON_URL || "";
const PUSH_BADGE = process.env.PUSH_BADGE_URL || "";

const SENDGRID_KEY  = process.env.SENDGRID_API_KEY || "";
const SENDGRID_FROM = process.env.SENDGRID_FROM_EMAIL || "";

function getIncomingApiKey(req) {
  // Authorization: Bearer xxx
  const auth = (req.headers.authorization || req.headers.Authorization || "").toString();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  // x-api-key (o variantes)
  const x = req.headers["x-api-key"] || req.headers["x-api-secret"] || req.headers["x-rampet-key"];
  return (Array.isArray(x) ? x[0] : (x || "")).toString().trim();
}

function isLikelyEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
const chunk = (arr, n) => { const out=[]; for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; };

// Recolecta emails desde clienteIds
async function collectEmails({ emails = [], clienteIds = [] }) {
  const set = new Set();
  (emails || []).forEach(e => { if (isLikelyEmail(e)) set.add(e.trim()); });

  if (db && Array.isArray(clienteIds) && clienteIds.length > 0) {
    const gets = clienteIds.map(id => db.collection(CLIENTS_COLLECTION).doc(String(id)).get());
    const docs = await Promise.all(gets);
    docs.forEach(d => {
      if (!d.exists) return;
      const data = d.data() || {};
      if (isLikelyEmail(data.email)) set.add(String(data.email).trim());
      if (Array.isArray(data.emails)) {
        data.emails.forEach(e => { if (isLikelyEmail(e)) set.add(e.trim()); });
      }
    });
  }
  return Array.from(set);
}

// Recolecta tokens desde clienteIds
async function collectTokensFromClienteIds(clienteIds = []) {
  if (!db || !Array.isArray(clienteIds) || clienteIds.length === 0) return [];
  const set = new Set();
  const gets = clienteIds.map(id => db.collection(CLIENTS_COLLECTION).doc(String(id)).get());
  const docs = await Promise.all(gets);
  docs.forEach(d => {
    if (!d.exists) return;
    const data = d.data() || {};
    const arr = Array.isArray(data[FCM_TOKENS_FIELD]) ? data[FCM_TOKENS_FIELD] : [];
    arr.forEach(t => { if (typeof t === "string" && t.trim()) set.add(t.trim()); });
  });
  return Array.from(set);
}

async function removeInvalidTokensFromDocs(clienteIds = [], invalidTokens = []) {
  if (!db || !Array.isArray(clienteIds) || clienteIds.length === 0) return 0;
  let cleaned = 0;
  try {
    for (const id of clienteIds) {
      const ref = db.collection(CLIENTS_COLLECTION).doc(String(id));
      const snap = await ref.get();
      if (!snap.exists) continue;
      const data = snap.data() || {};
      const before = Array.isArray(data[FCM_TOKENS_FIELD]) ? data[FCM_TOKENS_FIELD] : [];
      const after  = before.filter(t => !invalidTokens.includes(t));
      if (after.length !== before.length) {
        await ref.update({ [FCM_TOKENS_FIELD]: after });
        cleaned++;
      }
    }
  } catch (e) {
    console.error("[send-notification] removeInvalidTokensFromDocs:", e?.message || e);
  }
  return cleaned;
}

// Emails con SendGrid
async function sendEmailsWithSendGrid({ subject, htmlBody, textBody, toList }) {
  const key = SENDGRID_KEY;
  const from = SENDGRID_FROM;
  if (!key || !from) {
    return { attempted: 0, sent: 0, failed: toList.length, skipped: true, errors: ["SendGrid no configurado"] };
  }

  sgMail.setApiKey(key);
  const msgs = toList.map(to => ({
    to, from,
    subject: subject || "RAMPET",
    html: htmlBody || `<p>${(textBody || "").replace(/\n/g, "<br>")}</p>`,
    text: textBody || "",
  }));

  let sent = 0, failed = 0; const errors = [];
  for (const batch of chunk(msgs, 500)) {
    try { await sgMail.send(batch, { batch: true }); sent += batch.length; }
    catch (e) { failed += batch.length; errors.push(String(e?.message || e)); }
  }
  return { attempted: sent + failed, sent, failed, skipped: false, errors };
}

// ────────────── Handler ──────────────
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

  // Auth interna (con logs mínimos)
  const incoming = getIncomingApiKey(req);
  const incomingLen = (incoming || "").length;
  const secretLen   = (API_SECRET || "").length;
  console.log("[send-notification][auth] secret_present:", !!API_SECRET, "incoming_present:", !!incoming, "lens:", { incomingLen, secretLen });

  if (!API_SECRET || !incoming || incoming !== API_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const body = await readJson(req);
    let {
      title = "RAMPET",
      body: notifBody = "",
      tokens = [],
      clienteIds = [],
      emails = [],
      data = {},
    } = body || {};

    // Fallbacks: si viene clienteIds, completamos tokens/emails desde Firestore
    if ((!tokens || tokens.length === 0) && Array.isArray(clienteIds) && clienteIds.length > 0) {
      tokens = await collectTokensFromClienteIds(clienteIds);
      if (!Array.isArray(emails) || emails.length === 0) {
        emails = await collectEmails({ emails: [], clienteIds });
      }
    }

    // PUSH
    let successCount = 0, failureCount = 0, invalidTokens = [], cleanedDocs = 0, mode = "none";
    if (Array.isArray(tokens) && tokens.length > 0 && messaging) {
      mode = "multicast";
      const dataForFCM = {};
      Object.entries(data || {}).forEach(([k,v]) => { dataForFCM[k] = typeof v === "string" ? v : JSON.stringify(v); });

      const fcmPayload = {
        tokens,
        notification: undefined,
        data: dataForFCM,
        webpush: {
          notification: { title, body: notifBody, icon: PUSH_ICON || undefined, badge: PUSH_BADGE || undefined },
          fcmOptions: { link: PWA_URL },
        },
      };

      const resp = await messaging.sendEachForMulticast(fcmPayload);
      successCount = resp.successCount;
      failureCount = resp.failureCount;

      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const errCode = r.error?.errorInfo?.code || r.error?.code || "";
          if (["messaging/invalid-registration-token","messaging/registration-token-not-registered"].includes(errCode)) {
            invalidTokens.push(tokens[idx]);
          }
        }
      });

      if (invalidTokens.length && Array.isArray(clienteIds) && clienteIds.length) {
        cleanedDocs = await removeInvalidTokensFromDocs(clienteIds, invalidTokens);
      }
    }

    // EMAILS (independiente de tokens)
    let emailReport = { attempted: 0, sent: 0, failed: 0, skipped: true, errors: [] };
    if (!Array.isArray(emails) || emails.length === 0) {
      if (Array.isArray(clienteIds) && clienteIds.length > 0) {
        emails = await collectEmails({ emails: [], clienteIds });
      }
    }
    if (Array.isArray(emails) && emails.length > 0) {
      emailReport = await sendEmailsWithSendGrid({
        subject: title,
        textBody: notifBody,
        htmlBody: `<h2>${title}</h2><p>${notifBody}</p>`,
        toList: emails,
      });
    }

    return res.status(200).json({
      ok: true,
      mode, successCount, failureCount,
      invalidTokens, cleanedDocs,
      emails: emailReport,
    });
  } catch (e) {
    console.error("[send-notification] error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
