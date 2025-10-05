// api/create-user.js
// Alta de usuario (Auth + Firestore) con CORS + x-api-key + body seguro.
// Idempotente. Mantiene contrato original (busca por email; si no hay, usa docId o crea ID).
// Aditivo: dni/dni_norm, domicilio flexible. T&C aceptados (alta desde Panel).

import admin from "firebase-admin";

// ---------- Firebase Admin ----------
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
    const e = new Error("BAD_JSON"); e.code = "BAD_JSON"; throw e;
  }
}

// ---------- Util ----------
function nowTs() { return admin.firestore.FieldValue.serverTimestamp(); }
const toStr = v => (v == null ? "" : String(v).trim());

function composeAddressLine(components = {}) {
  const { calle, numero, piso, depto, barrio, localidad, partido, provincia, cp, pais, addressLine } = components || {};
  if (addressLine && String(addressLine).trim()) return String(addressLine).trim();
  const parts = [
    [calle, numero].filter(Boolean).join(" ").trim(),
    [piso, depto].filter(Boolean).join(" ").trim(),
    barrio,
    localidad || partido,
    provincia,
    cp ? `CP ${cp}` : null,
    pais
  ].filter(Boolean);
  return parts.join(", ").replace(/\s+,/g, ",").replace(/,\s+,/g, ",");
}

// ---------- Handler ----------
export default async function handler(req, res) {
  const allowOrigin = getAllowedOrigin(req);
  setCors(res, allowOrigin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "/api/create-user", corsOrigin: allowOrigin || null });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  // API key
  const clientKey = req.headers["x-api-key"];
  if (!clientKey || clientKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // Body
  let payload = {};
  try { payload = await readJsonBody(req); }
  catch (e) {
    return res.status(400).json({ ok: false, error: e?.code === "BAD_JSON" ? "Invalid JSON body" : "Invalid request body" });
  }

  try {
    const db = getDb();

    // Campos
    let {
      email, dni, nombre, telefono,
      numeroSocio, fechaNacimiento, fechaInscripcion,
      domicilio, docId, direccion, address
    } = payload || {};

    if (!email || !dni) return res.status(400).json({ ok: false, error: "Faltan campos obligatorios: email y dni" });
    email = String(email).toLowerCase().trim();
    dni = toStr(dni);
    if (dni.length < 6) return res.status(400).json({ ok: false, error: "El DNI/clave debe tener al menos 6 caracteres" });

    // 1) Auth
    initFirebaseAdmin();
    let authUser = null;
    let createdAuth = false;
    try {
      authUser = await admin.auth().getUserByEmail(email);
    } catch {
      try {
        authUser = await admin.auth().createUser({
          email,
          password: dni,
          displayName: nombre || "",
          phoneNumber: telefono ? `+54${telefono}`.replace(/\D/g, "") : undefined,
          emailVerified: false,
          disabled: false,
        });
        createdAuth = true;
      } catch (e) {
        if (telefono) {
          authUser = await admin.auth().createUser({
            email, password: dni, displayName: nombre || "",
            emailVerified: false, disabled: false
          });
          createdAuth = true;
        } else {
          return res.status(500).json({ ok: false, error: "Auth creation failed" });
        }
      }
    }
    const authUID = authUser.uid;

    // 2) Firestore
    const col = db.collection("clientes");
    const fsDocSnap = await col.where("email", "==", email).limit(1).get();
    let fsDocRef = null;
    let createdFs = false;

    // domicilio flexible
    let domicilioObj = null;
    if (domicilio && typeof domicilio === "object") {
      domicilioObj = {
        status: domicilio.status || "manual",
        addressLine: toStr(domicilio.addressLine || ""),
        components: domicilio.components || {},
      };
      if (domicilioObj.components && !domicilioObj.addressLine) {
        const composed = composeAddressLine(domicilioObj.components);
        if (composed) domicilioObj.addressLine = composed;
      }
      if (!domicilioObj.addressLine && !Object.keys(domicilioObj.components).length) domicilioObj = null;
    } else if (typeof domicilio === "string" && domicilio.trim()) {
      domicilioObj = { status: "manual", addressLine: toStr(domicilio), components: {} };
    } else if ((direccion && toStr(direccion)) || (address && toStr(address))) {
      domicilioObj = { status: "manual", addressLine: toStr(direccion || address), components: {} };
    }

    // leer versión T&C (opcional)
    let tycVersion = null;
    try {
      const cfg = await db.collection("configuracion").doc("principal").get();
      if (cfg.exists) tycVersion = cfg.get("tycVersion") || null;
    } catch {}

    const tycBlock = { accepted: true, source: "panel", acceptedAt: nowTs(), ...(tycVersion ? { version: String(tycVersion) } : {}) };

    const buildFsPayload = (isNew) => {
      const base = {
        email,
        nombre: isNew ? (nombre || "") : (nombre ?? admin.firestore.FieldValue.delete()),
        telefono: isNew ? (telefono || "") : (telefono ?? admin.firestore.FieldValue.delete()),
        numeroSocio: (numeroSocio != null) ? Number(numeroSocio) : (isNew ? null : admin.firestore.FieldValue.delete()),
        authUID,
        estado: "activo",
        dni,
        dni_norm: dni.replace(/\D+/g, ""),
        tyc: tycBlock
      };
      if (fechaNacimiento) base.fechaNacimiento = fechaNacimiento;
      if (fechaInscripcion) base.fechaInscripcion = fechaInscripcion;
      if (domicilioObj) {
        base.domicilio = {
          status: domicilioObj.status,
          addressLine: domicilioObj.addressLine || "",
          components: domicilioObj.components || {},
          updatedBy: "admin",
          updatedAt: nowTs(),
        };
      }
      if (isNew) { base.fcmTokens = []; base.createdAt = nowTs(); }
      base.updatedAt = nowTs();
      return base;
    };

    if (!fsDocSnap.empty) {
      fsDocRef = fsDocSnap.docs[0].ref;
      await fsDocRef.set(buildFsPayload(false), { merge: true });
    } else {
      fsDocRef = docId ? col.doc(docId) : col.doc();
      await fsDocRef.set(buildFsPayload(true), { merge: false });
      createdFs = true;
    }

    return res.status(200).json({
      ok: true,
      auth: { uid: authUID, created: createdAuth },
      firestore: { docId: fsDocRef.id, created: createdFs },
    });

  } catch (err) {
    console.error("create-user error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
