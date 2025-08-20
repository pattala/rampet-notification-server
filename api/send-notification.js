// /api/send-notification.js  (Vercel runtime "nodejs" – ESM)
export const config = { runtime: "nodejs" };

import admin from "firebase-admin";
import sgMail from "@sendgrid/mail";

/* ───────────────────── CORS ───────────────────── */
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
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, x-api-key"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

// Llamada interna server-to-server (con API secret) => permitir aunque no haya Origin
function isInternal(req) {
  const h = req.headers || {};
  const key  = (process.env.API_SECRET_KEY || process.env.MI_API_SECRET || "").trim();
  const auth = (h.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const xKey = (h["x-api-key"] || "").trim();
  return !!key && (auth === key || xKey === key);
}



/* ───────────────────── Firebase init ───────────────────── */
let messaging = null;
let db = null;
try {
  const hasCred = !!process.env.GOOGLE_CREDENTIALS_JSON;
  console.log("[send-notification] GOOGLE_CREDENTIALS_JSON present:", hasCred);

  let credJson = null;
  if (hasCred) {
    try { credJson = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); }
    catch (e) { console.error("[send-notification] creds JSON.parse:", e?.message); }
  }

  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
        credential: credJson
          ? admin.credential.cert(credJson)
          : admin.credential.applicationDefault(),
      });

  messaging = admin.messaging(app);
  db = admin.firestore(app);
} catch (e) {
  console.error("[send-notification] Firebase init error:", e);
}

/* ───────────────────── Constantes ───────────────────── */
const API_SECRET = (process.env.API_SECRET_KEY || process.env.MI_API_SECRET || "").trim();

const CLIENTS_COLLECTION = process.env.CLIENTS_COLLECTION || "clientes";
const FCM_TOKENS_FIELD  = "fcmTokens";

const PWA_URL        = process.env.PWA_URL || "https://rampet.vercel.app";
const PUSH_ICON_URL  = process.env.PUSH_ICON_URL || PWA_URL + "/icon-192.png";
const PUSH_BADGE_URL = process.env.PUSH_BADGE_URL || PUSH_ICON_URL;

const SG_KEY  = (process.env.SENDGRID_API_KEY || "").trim();
const SG_FROM = (process.env.SENDGRID_FROM_EMAIL || "").trim();

/* ───────────────────── Utils ───────────────────── */
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
const isLikelyEmail = (s) =>
  typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/* ───────────────────── Destinatarios ───────────────────── */
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

/* ───────────────────── Email Template ───────────────────── */
function applyPlaceholders(str, data = {}) {
  // {nombre_campana}, {cuerpo_campana}, etc.
  return String(str || "").replace(/\{(\w+)\}/g, (_, k) => String(data?.[k] ?? ""));
}
function renderEmailHtml({ title, body, templateData }) {
  const vig = (templateData?.vence_text || "").trim();
  const VIG_TXT = vig ? `Vigencia: ${vig}` : "";
  const bodyWithVig = String(body || "").replace("[TEXTO_VIGENCIA]", VIG_TXT);

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title || "RAMPET")}</title></head>
<body style="margin:0;padding:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#111">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7fb;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="620" cellspacing="0" cellpadding="0" style="background:#fff;border-radius:12px;padding:24px">
        <tr><td style="text-align:center;padding-bottom:8px">
          <img src="${PUSH_ICON_URL}" alt="RAMPET" width="64" height="64" style="border-radius:12px;display:inline-block"/>
        </td></tr>
        <tr><td style="font-size:22px;font-weight:700;padding:8px 0 4px 0;text-align:center">${escapeHtml(title || "RAMPET")}</td></tr>
        <tr><td style="font-size:15px;line-height:1.55;padding:8px 0 12px 0;white-space:pre-line">
          ${escapeHtml(bodyWithVig)}
        </td></tr>
        ${VIG_TXT ? `<tr><td style="font-size:13px;color:#444;padding:4px 0 12px 0"><em>${escapeHtml(VIG_TXT)}</em></td></tr>` : ""}
        <tr><td style="text-align:center;padding-top:16px">
          <a href="${PWA_URL}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Abrir RAMPET</a>
        </td></tr>
      </table>
      <div style="font-size:12px;color:#666;margin-top:12px">© RAMPET</div>
    </td></tr>
  </table>
</body>
</html>`;
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

/* ───────────────────── Envíos ───────────────────── */
async function sendPushMulticast({ title, body, tokens = [], data = {} }) {
  if (!messaging || !Array.isArray(tokens) || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, invalidTokens: [] };
  }

  // DEDUPE: garantizamos 1 solo envío
  const uniq = Array.from(new Set(tokens.map(t => (t || "").trim()).filter(Boolean)));

  const message = {
    tokens: uniq,
    notification: { title, body },
    webpush: {
      notification: { title, body, icon: PUSH_ICON_URL, badge: PUSH_BADGE_URL },
      fcmOptions: { link: PWA_URL }
    },
    data: Object.fromEntries(Object.entries(data || {}).map(([k,v])=>[String(k), String(v ?? "")])),
  };

  const resp = await messaging.sendEachForMulticast(message);
  const invalid = [];
  resp.responses.forEach((r, idx) => {
    if (!r.success) {
      const e = r.error?.errorInfo?.code || r.error?.code || "";
      if (e.includes("registration-token-not-registered")) invalid.push(uniq[idx]);
    }
  });

  // Limpieza opcional en Firestore (si db disponible y hay clienteIds en data)
  if (invalid.length && db && Array.isArray(data.clienteIds)) {
    try {
      const batch = db.batch();
      for (const cid of data.clienteIds) {
        const ref = db.collection(CLIENTS_COLLECTION).doc(String(cid));
        batch.update(ref, { [FCM_TOKENS_FIELD]: admin.firestore.FieldValue.arrayRemove(...invalid) });
      }
      await batch.commit();
    } catch (e) {
      console.warn("[send-notification] clean tokens warn:", e?.message);
    }
  }

  return {
    successCount: resp.successCount,
    failureCount: resp.failureCount,
    invalidTokens: invalid,
  };
}

async function sendEmailsWithSendGrid({ subject, htmlBody, textBody, toList }) {
  if (!SG_KEY || !SG_FROM || !Array.isArray(toList) || toList.length === 0) {
    return { attempted: 0, sent: 0, failed: toList?.length || 0, skipped: true, errors: ["SendGrid no configurado o sin destinatarios"] };
  }
  sgMail.setApiKey(SG_KEY);

  const msgs = toList.map(to => ({
    to, from: SG_FROM,
    subject: subject || "RAMPET",
    html: htmlBody || `<p>${(textBody || "").replace(/\n/g,"<br>")}</p>`,
    text: textBody || "",
  }));

  let sent = 0, failed = 0; const errors = [];
  // En bloques moderados (SG soporta batch)
  const chunkSize = 500;
  for (let i=0; i<msgs.length; i+=chunkSize) {
    const batch = msgs.slice(i, i+chunkSize);
    try {
      const res = await sgMail.send(batch, { batch: true });
      // Si no tira, contabilizamos como enviado
      sent += batch.length;
    } catch (e) {
      failed += batch.length;
      errors.push(String(e?.message || e));
    }
  }
  return { attempted: msgs.length, sent, failed, errors };
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
 // Permitir llamadas internas (programar-lanzamiento -> send-notification) aunque no haya Origin
if (!originAllowed(origin) && !isInternal(req)) {
  return res.status(403).json({ ok: false, error: "Origin not allowed" });
}

  try {
    // Auth
    const auth = (req.headers.authorization || "").trim(); // "Bearer X"
    const apiKey = (req.headers["x-api-key"] || req.headers["x-api-key".toLowerCase()] || "").trim();
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!API_SECRET || (token !== API_SECRET && apiKey !== API_SECRET)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const {
      title, body,
      templateId, templateData = {},
      tokens = [],
      clienteIds = [],
      emails = [],
      data = {}
    } = await readJson(req);

    // 1) Unificamos tokens y emails con dedupe
    const tokensFromIds = await collectTokensFromClienteIds(clienteIds);
    const allTokens = Array.from(new Set([...(tokens || []), ...tokensFromIds].map(t => (t || "").trim()).filter(Boolean)));

    const allEmails = await collectEmails({ emails, clienteIds });

    // 2) Email template (si no viene HTML ya listo)
    //    subject = title; body = con placeholders + [TEXTO_VIGENCIA]
    const subject = title || templateData?.titulo || "RAMPET";
    const baseBody = body || templateData?.descripcion || "";
    const emailBody = applyPlaceholders(baseBody, {
      nombre_campana: templateData?.titulo || subject,
      cuerpo_campana: baseBody,
      ...templateData,
    });
    const htmlBody = renderEmailHtml({ title: subject, body: emailBody, templateData });

    // 3) Push
    const pushResp = await sendPushMulticast({
      title: subject,
      body: emailBody,
      tokens: allTokens,
      data: {
        ...Object.fromEntries(Object.entries(data || {}).map(([k,v])=>[String(k), String(v ?? "")])),
        templateId: String(templateId || ""),
        clienteIds: clienteIds, // para limpieza opcional
      },
    });

    // 4) Email
    const emailResp = await sendEmailsWithSendGrid({
      subject: subject,
      htmlBody,
      textBody: emailBody,
      toList: allEmails,
    });

    return res.status(200).json({
      ok: true,
      mode: allTokens.length ? (allEmails.length ? "both" : "push") : (allEmails.length ? "email" : "none"),
      successCount: pushResp.successCount,
      failureCount: pushResp.failureCount,
      invalidTokens: pushResp.invalidTokens,
      emails: emailResp,
    });
  } catch (e) {
    console.error("[send-notification] handler error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
