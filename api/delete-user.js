// api/delete-user.js
// Purga total SIEMPRE: borra doc en Firestore, datos relacionados (geo_raw, subcolecciones configurables)
// y también usuario en Firebase Auth (si existe).
// CORS robusto + x-api-key + lectura de body segura (sin req.body para evitar "Invalid JSON" en Vercel).

import admin from "firebase-admin";

/* ─────────────────────────────────────────────────────────────
   Firebase Admin
   ──────────────────────────────────────────────────────────── */
function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS_JSON missing");

  let sa;
  try { sa = JSON.parse(raw); }
  catch { throw new Error("Invalid GOOGLE_CREDENTIALS_JSON (not valid JSON)"); }

  admin.initializeApp({
    credential: admin.credential.cert(sa),
  });
}

function getDb() {
  initFirebaseAdmin();
  return admin.firestore();
}

/* ─────────────────────────────────────────────────────────────
   CORS
   ──────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────
   Body seguro
   ──────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────
   Resolver cliente
   ──────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────
   NUEVO: Helpers de borrado en cascada
   ──────────────────────────────────────────────────────────── */

/**
 * Borra documentos que cumplan un query, en lotes de 500, hasta vaciar.
 * Acepta una función "makeQuery" para rearmar el query en cada pasada.
 */
async function deleteByQueryPaged(db, makeQuery, label = "batch") {
  // Repite hasta que el query no devuelva más docs
  while (true) {
    const snap = await makeQuery().get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    // Vuelve a iterar hasta vaciar
  }
  console.log(`[delete-user][cascade] ${label}: completo`);
}

/**
 * Borra subcolecciones bajo clientes/{docId} si agregás nombres en el array.
 * De momento no se encontraron subcolecciones obligatorias; queda como hook.
 */
async function deleteClienteSubcollections(db, docId) {
  // Si en el futuro agregás subcolecciones, listalas acá:
  // p.ej.: const subs = ["geo", "historialPuntos", "historialCanjes"];
  const subs = ["geo_raw"];

  for (const sub of subs) {
    const makeQuery = () => db.collection(`clientes/${docId}/${sub}`).limit(500);
    await deleteByQueryPaged(db, makeQuery, `clientes/${docId}/${sub}`);
  }
}

/**
 * Borra registros sueltos relacionados al cliente (por ej. geo_raw)
 * Considera que en geo_raw puede existir campo "uid" y/o "clienteId"
 */
async function deleteLooseCollections(db, { uid, docId }) {
  // GEO RAW por uid
  const makeQueryUid = () => db.collection("geo_raw").where("uid", "==", uid).limit(500);
  await deleteByQueryPaged(db, makeQueryUid, `geo_raw where uid==${uid}`);

  // GEO RAW por clienteId (id de doc en clientes)
  const makeQueryDoc = () => db.collection("geo_raw").where("clienteId", "==", docId).limit(500);
  await deleteByQueryPaged(db, makeQueryDoc, `geo_raw where clienteId==${docId}`);
}

/* ─────────────────────────────────────────────────────────────
   Handler
   ──────────────────────────────────────────────────────────── */
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
      tips: "POST con x-api-key y body { docId | numeroSocio | authUID | email } (purga total en cascada).",
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

    const { docId, numeroSocio, authUID, email } = payload || {};
    if (!docId && !numeroSocio && !authUID && !email) {
      return res.status(400).json({
        ok: false,
        error: "Parámetros inválidos. Envíe al menos uno: docId | numeroSocio | authUID | email",
      });
    }

    // 1) Resolver doc/cliente (si ya borraste antes, found puede venir null)
    const found = await findClienteDoc(db, { docId, numeroSocio, authUID, email });

    let deletedDocId = null;
    let matchedBy = null;
    let data = null;

    // Capturamos uid/docId para cascada incluso si el doc ya no está
    let resolvedDocId = found?.id || docId || null;
    let resolvedAuthUID = authUID || found?.data?.authUID || null;
    let resolvedEmail = email || found?.data?.email || null;

    // 2) Si hay doc, borra primero datos relacionados (cascada), luego el doc
    if (found) {
      deletedDocId = found.id;
      data = found.data;
      matchedBy = docId ? "docId" : authUID ? "authUID" : email ? "email" : "numeroSocio";

      // 2.a) Cascada de subcolecciones bajo clientes/{docId} (si configuras subs)
      await deleteClienteSubcollections(db, found.id);

      // 2.b) Cascada de colecciones sueltas (geo_raw por uid/clienteId)
      await deleteLooseCollections(db, {
        uid: data?.authUID || resolvedAuthUID || "",
        docId: found.id
      });

      // 2.c) Borrar documento en Firestore
      await db.collection("clientes").doc(found.id).delete();
    } else {
      // Si no encontramos el doc, igualmente hacemos cascada por pistas que tengamos
      matchedBy = docId ? "docId" : authUID ? "authUID" : email ? "email" : "numeroSocio";

      // Intento de cascada mínima: si tenemos docId o authUID, limpiamos geo_raw
      if (resolvedDocId || resolvedAuthUID) {
        await deleteLooseCollections(db, {
          uid: resolvedAuthUID || "",
          docId: resolvedDocId || ""
        });
      }
    }

    // 3) Borrar usuario en Auth (si existe), siempre (purga total)
    initFirebaseAdmin();

    // Resolver UID por prioridad: payload.authUID -> data.authUID -> email (lookup)
    let uidToDelete = resolvedAuthUID || data?.authUID || null;

    if (!uidToDelete) {
      const emailToResolve = resolvedEmail || data?.email;
      if (emailToResolve) {
        try {
          const user = await admin.auth().getUserByEmail(String(emailToResolve).toLowerCase());
          uidToDelete = user.uid;
        } catch {
          // no existe por email -> seguimos sin romper
        }
      }
    }

    let authDeletion = null;
    if (uidToDelete) {
      try {
        await admin.auth().deleteUser(uidToDelete);
        authDeletion = { deleted: true, uid: uidToDelete };
      } catch (e) {
        // no rompas la operación principal: reportá el fallo
        authDeletion = { deleted: false, uid: uidToDelete, error: e?.message || String(e) };
      }
    } else {
      authDeletion = { deleted: false, reason: "auth user not found" };
    }

    return res.status(200).json({
      ok: true,
      deletedDocId,
      matchedBy,
      authDeletion,
      cascade: { geo_raw: "done", subcollections: "done" }
    });
  } catch (err) {
    console.error("delete-user error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
