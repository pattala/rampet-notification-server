// api/assign-socio-number.js
// Asigna numeroSocio con transacción y SOLO envía bienvenida si sendWelcome:true.

import admin from "firebase-admin";

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

// CORS
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization");
}

// Body
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function buildBaseUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  if (host) return `${proto}://${host}`;
  return process.env.SELF_BASE_URL || "";
}

export default async function handler(req, res) {
  const allowOrigin = getAllowedOrigin(req);
  setCors(res, allowOrigin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "/api/assign-socio-number", corsOrigin: allowOrigin || null });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // API key
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

  const { docId, uid, sendWelcome } = payload || {};
  if (!docId && !uid) {
    return res.status(400).json({ ok: false, error: "Falta docId o uid" });
  }

  try {
    const db = getDb();
    let clienteRef;

    if (docId) {
      clienteRef = db.collection("clientes").doc(String(docId));
    } else {
      const q = await db.collection("clientes").where("authUID", "==", String(uid)).limit(1).get();
      if (q.empty) return res.status(404).json({ ok: false, error: "Cliente no encontrado por uid" });
      clienteRef = q.docs[0].ref;
    }

    const contadorRef = db.collection("configuracion").doc("contadorSocio");

    let numeroAsignado = null;
    await db.runTransaction(async (tx) => {
      const [contSnap, cliSnap] = await Promise.all([tx.get(contadorRef), tx.get(clienteRef)]);
      if (!cliSnap.exists) throw new Error("Cliente no existe");

      let ultimo = 0;
      if (contSnap.exists && typeof contSnap.get("ultimoNumero") === "number") ultimo = contSnap.get("ultimoNumero");
      numeroAsignado = ultimo + 1;

      tx.set(contadorRef, {
        ultimoNumero: numeroAsignado,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(clienteRef, {
        numeroSocio: numeroAsignado,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    // Enviar bienvenida SOLO si lo pidió el Panel
    let mail = { attempted: false, ok: false };
    if (sendWelcome === true) {
      mail.attempted = true;
      try {
        const baseUrl = buildBaseUrl(req);
        if (!baseUrl) throw new Error("Base URL not resolved");

        const cli = await clienteRef.get();
        const data = cli.data() || {};
        const to = data.email;
        const nombre = data.nombre || "";

        const resp = await fetch(`${baseUrl}/api/send-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.API_SECRET_KEY || ""
          },
          body: JSON.stringify({
            to,
            templateId: "bienvenida",
            variables: { nombre, numero_socio: numeroAsignado }
          })
        });
        const jr = await resp.json().catch(() => ({}));
        mail.ok = resp.ok || (resp.status >= 200 && resp.status < 300);
        mail.response = jr;
      } catch (err) {
        console.error("send-welcome error:", err);
        mail.error = String(err?.message || err);
      }
    }

    return res.status(200).json({
      ok: true,
      message: "Número de socio asignado.",
      numeroSocio: numeroAsignado,
      mail
    });

  } catch (err) {
    console.error("assign-socio-number error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error", detail: err?.message });
  }
}
