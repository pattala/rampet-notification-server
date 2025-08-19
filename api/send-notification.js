// /api/send-notification.js (Vercel runtime "nodejs" – ESM)
export const config = { runtime: 'nodejs' };

// ────────────────────────── Imports ──────────────────────────
import admin from "firebase-admin";
import sgMail from "@sendgrid/mail";

// ───────────────── Firebase Admin (ESM) ─────────────────
let firebaseInitError = null;
let firebaseApp = null;
let messaging = null;
let db = null;

try {
  const hasCred = !!process.env.GOOGLE_CREDENTIALS_JSON;
  console.log("[send-notification] GOOGLE_CREDENTIALS_JSON present:", hasCred);

  let credJson = null;
  if (hasCred) {
    try { credJson = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); }
    catch (e) { console.error("[send-notification] GOOGLE_CREDENTIALS_JSON JSON.parse failed:", e?.message); }
  }

  if (!admin.apps.length) {
    firebaseApp = admin.initializeApp({
      credential: credJson ? admin.credential.cert(credJson) : admin.credential.applicationDefault(),
    });
  } else {
    firebaseApp = admin.app();
  }

  messaging = admin.messaging(firebaseApp);
  db = admin.firestore(firebaseApp);
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

// ───────────────── Config de datos ─────────────────
// Si tu colección NO se llama 'clientes', cambiala con la env CLIENTS_COLLECTION
const CLIENTS_COLLECTION = process.env.CLIENTS_COLLECTION || "clientes";
const FCM_TOKENS_FIELD = "fcmTokens";

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

// ───────────── Limpieza automática de tokens inválidos ─────────────
async function cleanupInvalidTokens(invalidTokens = []) {
  if (!db || invalidTokens.length === 0) return { cleanedDocs: 0 };

  let cleanedDocs = 0;
  for (const token of invalidTokens) {
    try {
      const snap = await db
        .collection(CLIENTS_COLLECTION)
        .where(FCM_TOKENS_FIELD, "array-contains", token)
        .get();

      if (snap.empty) continue;

      const batch = db.batch();
      snap.forEach(doc => {
        batch.update(doc.ref, { [FCM_TOKENS_FIELD]: admin.firestore.FieldValue.arrayRemove(token) });
      });
      await batch.commit();
      cleanedDocs += snap.size;
      console.log(`[send-notification] Cleaned token ${token} from ${snap.size} doc(s).`);
    } catch (e) {
      console.error("[send-notification] cleanupInvalidTokens error:", e?.message || e);
    }
  }
  return { cleanedDocs };
}

// ───────────── Emails (SendGrid) ─────────────
function isLikelyEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

async function collectEmails({ emails = [], clienteIds = [] }) {
  const set = new Set();

  // 1) Directos en el payload
  (emails || []).forEach(e => { if (isLikelyEmail(e)) set.add(e.trim()); });

  // 2) Buscar por IDs en Firestore
  if (db && Array.isArray(clienteIds) && clienteIds.length > 0) {
    const gets = clienteIds.map(id => db.collection(CLIENTS_COLLECTION).doc(String(id)).get());
    const docs = await Promise.all(gets);
    docs.forEach(d => {
      if (d.exists) {
        const data = d.data() || {};
        if (isLikelyEmail(data.email)) set.add(String(data.email).trim());
        // Si tuvieras un array de emails adicional en el doc:
        if (Array.isArray(data.emails)) {
          data.emails.forEach(e => { if (isLikelyEmail(e)) set.add(e.trim()); });
        }
      }
    });
  }

  return Array.from(set);
}

// Recolecta tokens (fcmTokens) a partir de clienteIds en Firestore
async function collectTokensFromClienteIds(clienteIds = []) {
  if (!db || !Array.isArray(clienteIds) || clienteIds.length === 0) return [];
  const set = new Set();
  const gets = clienteIds.map(id =>
    db.collection(CLIENTS_COLLECTION).doc(String(id)).get()
  );
  const docs = await Promise.all(gets);
  docs.forEach(d => {
    if (!d.exists) return;
    const data = d.data() || {};
    const arr = Array.isArray(data[FCM_TOKENS_FIELD]) ? data[FCM_TOKENS_FIELD] : [];
    arr.forEach(t => {
      if (typeof t === "string" && t.trim()) set.add(t.trim());
    });
  });
  return Array.from(set);
}

async function sendEmailsWithSendGrid({ subject, htmlBody, textBody, toList }) {
  const key = process.env.SENDGRID_API_KEY || "";
  const from = process.env.SENDGRID_FROM_EMAIL || "";

  if (!key || !from) {
    return { attempted: 0, sent: 0, failed: toList.length, skipped: true, errors: ["SendGrid no configurado"] };
  }

  sgMail.setApiKey(key);

  const msgs = toList.map(to => ({
    to,
    from,
    subject: subject || "RAMPET",
    html: htmlBody || `<p>${(textBody || "").replace(/\n/g, "<br>")}</p>`,
    text: textBody || "",
  }));

  let sent = 0;
  let failed = 0;
  const errors = [];

  // Enviar en tandas
  const batches = chunk(msgs, 500);
  for (const batch of batches) {
    try {
      const res = await sgMail.send(batch, { batch: true });
      sent += Array.isArray(res) ? res.length : batch.length;
    } catch (e) {
      failed += batch.length;
      errors.push(String(e?.message || e));
      console.error("[send-notification] SendGrid batch error:", e);
    }
  }

  console.log(`[send-notification] Emails procesados: ${sent} enviados, ${failed} fallidos.`);
  return { attempted: toList.length, sent, failed, skipped: false, errors };
}

// ────────────────────────── Handler ──────────────────────────
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
      hint: "Revisá GOOGLE_CREDENTIALS_JSON en Vercel.",
      detail: String(firebaseInitError?.message || firebaseInitError || "Unknown"),
    });
  }

  try {
    const body = await readJson(req);

    // Payload flexible:
    // {
    //   tokens?: string[],
    //   topic?: string,
    //   title?: string,
    //   body?: string,
    //   icon?: string,
    //   badge?: string,
    //   link?: string,
    //   data?: Record<string,string|...>,
    //   emails?: string[],
    //   clienteIds?: (string|number)[]
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
      emails = [],
      clienteIds = [],
    } = body || {};

    // ───────────── WebPush ─────────────
    const webpush = buildWebpushPayload({ title, body: nBody, icon, badge, link });
    const safeData = toStringData(data);

    // Fallback: si no hay tokens, juntarlos desde clienteIds
    let tokensToUse = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
    if (tokensToUse.length === 0 && Array.isArray(clienteIds) && clienteIds.length > 0) {
      tokensToUse = await collectTokensFromClienteIds(clienteIds);
    }

    let pushResult = {
      ok: true,
      mode: "none",
      successCount: 0,
      failureCount: 0,
      invalidTokens: [],
      cleanedDocs: 0,
    };

    if (topic && (!tokensToUse || tokensToUse.length === 0)) {
      const msg = { topic, webpush, ...(Object.keys(safeData).length ? { data: safeData } : {}) };
      const messageId = await messaging.send(msg, false);
      pushResult = { ok: true, mode: "topic", successCount: 1, failureCount: 0, invalidTokens: [], cleanedDocs: 0, messageId };
    } else if (Array.isArray(tokensToUse) && tokensToUse.length > 0) {
      const batches = chunk(tokensToUse, 500);
      let success = 0, failure = 0;
      const invalidTokens = [];

      for (const tk of batches) {
        const msg = { tokens: tk, webpush, ...(Object.keys(safeData).length ? { data: safeData } : {}) };
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

      const { cleanedDocs } = await cleanupInvalidTokens(invalidTokens);
      pushResult = { ok: true, mode: "multicast", successCount: success, failureCount: failure, invalidTokens, cleanedDocs };
    }

    // ───────────── Emails (opcional) ─────────────
    let emailResult = { attempted: 0, sent: 0, failed: 0, skipped: true, errors: [] };
    if ((emails && emails.length) || (clienteIds && clienteIds.length)) {
      const list = await collectEmails({ emails, clienteIds });
      if (list.length > 0) {
        const subject = title || "RAMPET";
        const textBody = String(nBody || "");
        const htmlBody = `<p>${textBody.replace(/\n/g, "<br>")}</p>`;
        emailResult = await sendEmailsWithSendGrid({ subject, htmlBody, textBody, toList: list });
      }
    }

    return res.status(200).json({
      ok: true,
      ...pushResult,
      emails: emailResult,
    });
  } catch (err) {
    console.error("send-notification error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
