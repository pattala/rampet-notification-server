// api/delete-user.js
// CORS + x-api-key + borrado de Firestore (doc completo) y purga opcional en Firebase Auth.
// Versión defensiva: no usamos req.body (Vercel puede lanzar "Invalid JSON").

import admin from "firebase-admin";

// ---------- Firebase Admin ----------
function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS_JSON missing");

  let sa;
  try {
    sa = JSON.parse(raw);
  } catch {
    throw new Error("Invalid GOOGLE_CREDENTIALS_JSON (not valid JSON)");
  }

  admin.initializeApp({
    credential: admin.credential.cert(sa),
  });
}

function getDb() {
  initFirebaseAdmin();
  return admin.firestore();
}

// ---------- CORS ----------
function getAllowedOrigin(req) {
  const allowed = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
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

// ---------- Body seguro ----------
async function readJsonBody(req) {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    const e = new Error("BAD_JSON");
    e.code = "BAD_JSON";
    throw e;
  }
}

// ---------- Resolver cliente ----------
async function findClienteDoc(db, { docId, numeroSocio, authUID, email }) {
  const col = db.collection("clientes");

  if (docId) {
    const snap = await col.doc(docId).get();
    if (snap.exists) return { id: snap.id, data: snap.data() };
  }

  if (numeroSocio != null && numeroSocio !== "") {
    const n = Number(numeroSocio);
    if (!Number.isNaN(n)) {
      const q = await col.where("numeroSocio", "==", n).limit(1).get();
      if (!q.empty) {
        const d = q.docs[0];
        return { id: d.id, data: d.data() };
      }
    }
  }

  if (authUID) {
    const q = await col.where("authUID", "==", authUID).limit(1).get();
    if (!q.empty) {
      const d = q.docs[0];
      return { id: d.id, data: d.data() };
    }
  }

  if (email) {
    const q = await col.where("email", "==", String(email).toLowerCase()).limit(1).get();
    if (!q.empty) {
      const d = q.docs[0];
      return { id: d.id, data: d.data() };
    }
  }

  return null;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  const allowOrigin = getAllowedOrigin(req);
  setCors(res, allowOrigin);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/delete-user",
      corsOrigin: allowOrigin || null,
      project: "sistema-fidelizacion",
      tips: "POST con x-api-key y body { docId | numeroSocio | authUID | email, deleteAuth? }",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // API key
  const clientKey = req.headers["x-api-key"];
  if (!clientKey || clientKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // Body
  let payload = {};
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    if (e.code === "BAD_JSON") {
      return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    }
    return res.status(400).json({ ok: false, error: "Invalid request body" });
  }

  try {
    const db = getDb();

    const { docId, numeroSocio, authUID, email, deleteAuth } = payload || {};
    if (!docId && !numeroSocio && !authUID && !email) {
      return res.status(400).json({
        ok: false,
        error: "Parámetros inválidos. Envíe al menos uno: docId | numeroSocio | authUID | email",
      });
    }

    const found = await findClienteDoc(db, { docId, numeroSocio, authUID, email });
    if (!found) {
      return res.status(404).json({ ok: false, error: "Cliente no encontrado" });
    }

    const { id, data } = found;

    // 1) Borrar documento en Firestore (tu lógica actual)
    await db.collection("clientes").doc(id).delete();

    // 2) Purga opcional en Firebase Auth
    let authDeletion = null;
    if (deleteAuth === true) {
      try {
        initFirebaseAdmin();

        // Prioridad: body.authUID -> data.authUID -> getUserByEmail
        let uidToDelete = authUID || data?.authUID || null;

        if (!uidToDelete) {
          const emailToResolve = email || data?.email;
          if (emailToResolve) {
            try {
              const user = await admin.auth().getUserByEmail(String(emailToResolve).toLowerCase());
              uidToDelete = user.uid;
            } catch {
              // no existe en Auth por email -> seguimos sin romper
            }
          }
        }

        if (uidToDelete) {
          await admin.auth().deleteUser(uidToDelete);
          authDeletion = { deleted: true, uid: uidToDelete };
        } else {
          authDeletion = { deleted: false, reason: "auth user not found" };
        }
      } catch (e) {
        authDeletion = { deleted: false, error: e?.message || String(e) };
      }
    }

    return res.status(200).json({
      ok: true,
      deletedDocId: id,
      matchedBy: docId ? "docId" : authUID ? "authUID" : email ? "email" : "numeroSocio",
      authDeletion,
    });
  } catch (err) {
    console.error("delete-user error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
