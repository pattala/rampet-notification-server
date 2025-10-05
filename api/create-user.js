// api/create-user.js
// Alta de usuario (Auth + Firestore) con CORS + x-api-key + body seguro.
// Idempotente y compatible con el Panel: busca por email; si no existe, usa docId o nuevo ID.
// Incluye: dni + dni_norm, domicilio objeto/string, compose addressLine si faltara.

import admin from "firebase-admin";

// ---------- Firebase Admin ----------
function initFirebaseAdmin() {
  if (admin.apps.length) return;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS_JSON missing");
  let sa;
  try { sa = JSON.parse(raw); }
  catch { throw new Error("Invalid GOOGLE_CREDENTIALS_JSON (not valid JSON)"); }
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

// ---------- Utils ----------
function nowTs() { return admin.firestore.FieldValue.serverTimestamp(); }
const toStr = v => (v == null ? "" : String(v).trim());

function composeAddressLine(components = {}) {
  const {
    calle, numero, piso, depto, barrio, localidad, partido, provincia, cp, pais, addressLine
  } = components || {};
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

function toE164AR(phoneLike) {
  if (!phoneLike) return null;
  const digits = String(phoneLike).replace(/\D+/g, "");
  // Esperamos al menos 10-11 dígitos locales; prefijamos +54 si no tiene prefijo.
  if (!digits) return null;
  const withCC = digits.startsWith("54") ? digits : ("54" + digits);
  const e164 = "+" + withCC;
  // Firebase Auth requiere E.164 razonable (hasta ~15 dígitos)
  if (e164.length < 10 || e164.length > 16) return null;
  return e164;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  const allowOrigin = getAllowedOrigin(req);
  setCors(res, allowOrigin);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/create-user",
      corsOrigin: allowOrigin || null,
      project: "sistema-fidelizacion",
      tips: "POST con x-api-key y body { email, dni(password), nombre?, telefono?, numeroSocio?, fechaNacimiento?, fechaInscripcion?, domicilio? }",
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

    // Campos (algunos opcionales)
    let {
      email,
      dni,
      nombre,
      telefono,
      numeroSocio,
      fechaNacimiento,
      fechaInscripcion,
      domicilio,       // objeto {status,addressLine,components} o string
      docId,           // opcional (para forzar ID)
      direccion,       // string
      address          // string
    } = payload || {};

    // Validaciones mínimas
    if (!email || !dni) {
      return res.status(400).json({ ok: false, error: "Faltan campos obligatorios: email y dni" });
    }
    email = String(email).toLowerCase().trim();
    dni = toStr(dni);
    if (dni.length < 6) {
      return res.status(400).json({ ok: false, error: "El DNI/clave debe tener al menos 6 caracteres" });
    }

    // 1) Auth: crear usuario si no existe (si Auth falla, cortamos y NO tocamos Firestore)
    initFirebaseAdmin();
    let authUser = null;
    let createdAuth = false;

    try {
      authUser = await admin.auth().getUserByEmail(email);
    } catch {
      // no existe → crear
      const maybePhone = toE164AR(telefono);
      try {
        authUser = await admin.auth().createUser({
          email,
          password: dni,                 // password inicial = DNI
          displayName: nombre || "",
          phoneNumber: maybePhone || undefined,
          emailVerified: false,
          disabled: false,
        });
        createdAuth = true;
      } catch (e) {
        // Reintentar sin phone si el formato lo trabó
        if (maybePhone) {
          authUser = await admin.auth().createUser({
            email,
            password: dni,
            displayName: nombre || "",
            emailVerified: false,
            disabled: false,
          });
          createdAuth = true;
        } else {
          console.error("[create-user] Auth error:", e);
          return res.status(500).json({ ok: false, error: "Auth creation failed", detail: e?.message });
        }
      }
    }

    const authUID = authUser.uid;

    // 2) Firestore: mismo contrato del Panel (doc por email si existe; sino docId || nuevo)
    const col = db.collection("clientes");
    const fsDocSnap = await col.where("email", "==", email).limit(1).get();
    let fsDocRef = null;
    let createdFs = false;

    // Resolver domicilio: objeto con/sin status, string o alias direccion/address
    let domObj = null;
    if (domicilio && typeof domicilio === "object") {
      domObj = {
        status: domicilio.status || "manual",
        addressLine: toStr(domicilio.addressLine || ""),
        components: domicilio.components || {},
      };
      if (domObj.components && !domObj.addressLine) {
        const composed = composeAddressLine(domObj.components);
        if (composed) domObj.addressLine = composed;
      }
      if (!domObj.addressLine && !Object.keys(domObj.components).length) domObj = null;
    } else if (typeof domicilio === "string" && domicilio.trim()) {
      domObj = { status: "manual", addressLine: toStr(domicilio), components: {} };
    } else if ((direccion && toStr(direccion)) || (address && toStr(address))) {
      domObj = { status: "manual", addressLine: toStr(direccion || address), components: {} };
    }

    const buildFsPayload = (isNew) => {
      const base = {
        email,
        nombre: isNew ? (nombre || "") : (nombre ?? admin.firestore.FieldValue.delete()),
        telefono: isNew ? (telefono || "") : (telefono ?? admin.firestore.FieldValue.delete()),
        numeroSocio: (numeroSocio != null)
          ? Number(numeroSocio)
          : (isNew ? null : admin.firestore.FieldValue.delete()),
        authUID,
        estado: "activo",
        dni,
        dni_norm: dni.replace(/\D+/g, ""),
        updatedAt: nowTs(),
      };
      if (fechaNacimiento)  base.fechaNacimiento  = fechaNacimiento;
      if (fechaInscripcion) base.fechaInscripcion = fechaInscripcion;
      if (domObj) {
        base.domicilio = {
          status: domObj.status,
          addressLine: domObj.addressLine || "",
          components: domObj.components || {},
          updatedBy: "admin",
          updatedAt: nowTs(),
        };
      }
      if (isNew) {
        base.fcmTokens = [];
        base.createdAt = nowTs();
      }
      return base;
    };

    if (!fsDocSnap.empty) {
      // existe → merge al doc existente
      fsDocRef = fsDocSnap.docs[0].ref;
      await fsDocRef.set(buildFsPayload(false), { merge: true });
    } else {
      // nuevo → usa docId si vino; sino ID nuevo
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
    return res.status(500).json({ ok: false, error: "Internal Server Error", detail: err?.message });
  }
}
