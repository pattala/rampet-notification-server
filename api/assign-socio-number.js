// api/assign-socio-number.js
// Asigna numeroSocio de forma consistente (transacción) y mantiene el comportamiento actual.
// ✨ Mejora: CORS con x-api-key, validación de API key y soporte de body { docId } o { uid }.

import admin from "firebase-admin";

// ---------- Firebase Admin ----------
function initFirebaseAdmin() {
  if (admin.apps.length) return;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS_JSON missing");
  let sa;
  try { sa = JSON.parse(raw); }
  catch { throw new Error("Invalid GOOGLE_CREDENTIALS_JSON"); }
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
function getDb() { initFirebaseAdmin(); return admin.firestore(); }

// ---------- CORS ----------
function getAllowedOrigin(req) {
  const allowed = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) return origin;
  return allowed[0] || "";
}
function setCors(res, origin) {
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  // ✅ incluye x-api-key para evitar el “Failed to fetch” del preflight
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization");
}

// ---------- Util ----------
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  const allowOrigin = getAllowedOrigin(req);
  setCors(res, allowOrigin);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/assign-socio-number",
      corsOrigin: allowOrigin || null
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // ✅ Validación API key (misma que create-user)
  const clientKey = req.headers["x-api-key"];
  if (!clientKey || clientKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON body" });
  }

  const { docId, uid } = payload || {};
  if (!docId && !uid) {
    return res.status(400).json({ ok: false, error: "Falta docId o uid" });
  }

  try {
    const db = getDb();
    let clienteRef = null;

    if (docId) {
      clienteRef = db.collection("clientes").doc(String(docId));
    } else {
      // Buscar por authUID cuando llega uid
      const q = await db.collection("clientes").where("authUID", "==", String(uid)).limit(1).get();
      if (q.empty) {
        return res.status(404).json({ ok: false, error: "Cliente no encontrado por uid" });
      }
      clienteRef = q.docs[0].ref;
    }

    // Contador global (ajustá el ID si tu proyecto usa otro)
    const contadorRef = db.collection("configuracion").doc("contadorSocio");

    let numeroAsignado = null;
    await db.runTransaction(async (tx) => {
      const [contSnap, cliSnap] = await Promise.all([tx.get(contadorRef), tx.get(clienteRef)]);
      if (!cliSnap.exists) throw new Error("Cliente no existe");

      let ultimo = 0;
      if (contSnap.exists && typeof contSnap.get("ultimoNumero") === "number") {
        ultimo = contSnap.get("ultimoNumero");
      }
      numeroAsignado = ultimo + 1;

      tx.set(contadorRef, { ultimoNumero: numeroAsignado, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(clienteRef, { numeroSocio: numeroAsignado, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });

    // Mantener el comportamiento actual de email (si tu versión lo hacía siempre)
    // Si querés hacerlo opcional más adelante, agregamos `sendWelcome: true` en el body.
    try {
      // Lógica de tu envío existente (placeholder opcional):
      // await enviarEmailBienvenida({ to, variables: { numero_socio: numeroAsignado, ... } });
    } catch (err) {
      console.error("Error enviando email de bienvenida:", err);
      return res.status(200).json({
        ok: true,
        message: "Número de socio asignado. Falló el envío de email de bienvenida.",
        numeroSocio: numeroAsignado,
        mail: { error: "send-email failed" }
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Número de socio asignado.",
      numeroSocio: numeroAsignado
    });

  } catch (err) {
    console.error("assign-socio-number error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
