// api/delete-user.js
// Borra un cliente en Firestore con CORS habilitado y auth por x-api-key.
// Acepta POST o DELETE. Busca por docId o numeroSocio.

import admin from "firebase-admin";

// ===== Firebase Admin (singleton) =====
function initFirebaseAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.GOOGLE_CREDENTIALS_JSON || "";
    if (!raw) throw new Error("Falta GOOGLE_CREDENTIALS_JSON");
    let creds;
    try {
      creds = JSON.parse(raw);
    } catch {
      creds = JSON.parse(raw.replace(/\\n/g, "\n"));
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

// ===== CORS + Auth helpers =====
function parseAllowedOrigins() {
  const raw = (process.env.CORS_ALLOWED_ORIGINS || "").trim();
  return raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];
}

function applyCors(req, res) {
  const allowed = parseAllowedOrigins();
  const origin = req.headers.origin || "";
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
}

function ensureAuth(req) {
  const required = process.env.API_SECRET_KEY || "";
  if (!required) return true;
  const got = req.headers["x-api-key"] || req.headers["X-API-Key"];
  return got === required;
}

// ===== Handler =====
export default async function handler(req, res) {
  applyCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST" && req.method !== "DELETE") {
    return res.status(405).json({ ok: false, error: "Method not allowed. Use POST or DELETE." });
  }
  if (!ensureAuth(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }

  // Body: { docId?: string, numeroSocio?: string|number }
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON body." });
  }

  const docId = body?.docId?.toString().trim();
  const numeroSocio = body?.numeroSocio != null ? String(body.numeroSocio).trim() : "";

  if (!docId && !numeroSocio) {
    return res.status(400).json({ ok: false, error: "Falta docId o numeroSocio." });
  }

  try {
    const db = initFirebaseAdmin().firestore();
    let docRef;

    if (docId) {
      docRef = db.collection("clientes").doc(docId);
    } else {
      const snap = await db
        .collection("clientes")
        .where("numero", "==", numeroSocio)
        .limit(1)
        .get();
      if (snap.empty) return res.status(404).json({ ok: false, error: "Cliente no encontrado." });
      docRef = snap.docs[0].ref;
    }

    const snapDoc = await docRef.get();
    if (!snapDoc.exists) return res.status(404).json({ ok: false, error: "Cliente no encontrado." });

    // Limpieza opcional de tokens, etc. (dejar comentado si no aplica)
    // const data = snapDoc.data() || {};
    // const tokens = Array.isArray(data.fcmTokens) ? data.fcmTokens : [];

    await docRef.delete();

    return res.status(200).json({ ok: true, deletedId: docRef.id });
  } catch (err) {
    console.error("delete-user error:", err);
    return res.status(500).json({ ok: false, error: "Internal error", details: err?.message || String(err) });
  }
}
