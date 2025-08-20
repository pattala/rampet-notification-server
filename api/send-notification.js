// api/send-notification.js
// Envío de notificaciones FCM en modo "data-only" (sin notification)

import admin from "firebase-admin";

// ---------- Inicialización Firebase Admin (singleton) ----------
function initFirebaseAdmin() {
  if (!admin.apps.length) {
    const credsRaw = process.env.GOOGLE_CREDENTIALS_JSON || "";
    if (!credsRaw) {
      throw new Error("Falta GOOGLE_CREDENTIALS_JSON en variables de entorno.");
    }
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

// ---------- Utilidades ----------
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
  if (!required) return true; // si no definiste clave, no bloquea (no recomendado)
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

// ---------- Handler principal ----------
export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed. Use POST." });
  }
  if (!ensureAuth(req)) return res.status(401).json({ ok: false, error: "Unauthorized." });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON body." });
  }

  const {
    title = "",
    body: msgBody = "",
    tokens = [],
    click_action = "/mis-puntos",
    icon,
    badge,
    extraData = {},
  } = body || {};

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).json({ ok: false, error: "Faltan tokens (array con al menos 1 token)." });
  }

  // ⚠️ FCM exige strings en data
  const data = asStringRecord({
    title: title,
    body: msgBody,
    click_action,
    icon: icon || process.env.PUSH_ICON_URL || "",
    badge: badge || process.env.PUSH_BADGE_URL || "", // si no usás badge, queda vacío
    type: "simple",
    ...extraData,
  });

  const message = { tokens, data }; // ❗️sin notification/webpush.notification

  // ——— LOG TEMPORAL PARA DEPURAR (podés quitarlo después) ———
  console.log("FCM message about to send:", JSON.stringify(message));
  // ———————————————————————————————————————————————————————————

  try {
    const adminApp = initFirebaseAdmin();
    const resp = await adminApp.messaging().sendEachForMulticast(message);

    // Limpieza básica: tokens inválidos
    const invalidTokens = [];
    resp.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = r.error?.errorInfo?.code || r.error?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    return res.status(200).json({
      ok: true,
      successCount: resp.successCount,
      failureCount: resp.failureCount,
      invalidTokens,
    });
  } catch (err) {
    console.error("FCM send error:", err);
    return res.status(500).json({ ok: false, error: "FCM send error", details: err?.message || String(err) });
  }
}
