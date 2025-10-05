// api/create-user.js
// Alta de usuario (Auth + Firestore) con CORS + x-api-key + lectura de body segura.
// Idempotente: si ya existe en Auth/Firestore, completa lo que falte y responde ok.
// ✨ Aditivo: persiste DNI (dni + dni_norm) y admite domicilio como objeto o string/alias (direccion/address).

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

// ---------- Util ----------
function nowTs() {
  return admin.firestore.FieldValue.serverTimestamp();
}
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

    // Campos esperados (algunos opcionales)
    let {
      email,            // obligatorio
      dni,              // password por default
      nombre,           // opcional
      telefono,         // opcional
      numeroSocio,      // opcional
      fechaNacimiento,  // opcional (yyyy-mm-dd)
      fechaInscripcion, // opcional (yyyy-mm-dd)
      domicilio,        // opcional: { status, addressLine?, components? } | string
      docId,            // opcional (fijar ID del doc)
      // alias tolerados (string)
      direccion,
      address
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

    // 1) Auth: crear usuario si no existe
    initFirebaseAdmin();
    let authUser = null;
    let createdAuth = false;

    try {
      authUser = await admin.auth().getUserByEmail(email);
    } catch {
      // no existe → crear
      try {
        authUser = await admin.auth().createUser({
          email,
          password: dni,                 // clave por default = DNI
          displayName: nombre || "",
          phoneNumber: telefono ? `+54${telefono}`.replace(/\D/g, "") : undefined, // opcional
          emailVerified: false,
          disabled: false,
        });
        createdAuth = true;
      } catch (e) {
        // Reintentar sin phone si falló
        if (telefono) {
          authUser = await admin.auth().createUser({
            email,
            password: dni,
            displayName: nombre || "",
            emailVerified: false,
            disabled: false,
          });
          createdAuth = true;
        } else {
          console.error("create-user: Auth error:", e?.message || e);
          throw e;
        }
      }
    }

    const authUID = authUser.uid;

    // 2) Firestore: crear/actualizar doc cliente (MISMA LÓGICA ORIGINAL)
    const col = db.collection("clientes");

    // Intentar encontrar doc existente por email
    const fsDocSnap = await col.where("email", "==", email).limit(1).get();
    let fsDocRef = null;
    let createdFs = false;

    // Resolver domicilio: objeto con/sin status, string, o alias direccion/address
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
      if (!domicilioObj.addressLine && !Object.keys(domicilioObj.components).length) {
        domicilioObj = null;
      }
    } else if (typeof domicilio === "string" && domicilio.trim()) {
      domicilioObj = { status: "manual", addressLine: toStr(domicilio), components: {} };
    } else if ((direccion && toStr(direccion)) || (address && toStr(address))) {
      domicilioObj = { status: "manual", addressLine: toStr(direccion || address), components: {} };
    }

    // Helper: construir payload con campos opcionales
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
        // NUEVO: persistir DNI
        dni,
        dni_norm: dni.replace(/\D+/g, ""),
      };

      // campos de fecha opcionales (si vienen)
      if (fechaNacimiento) base.fechaNacimiento = fechaNacimiento;
      if (fechaInscripcion) base.fechaInscripcion = fechaInscripcion;

      // domicilio opcional (status/partial/complete o manual)
      if (domicilioObj) {
        base.domicilio = {
          status: domicilioObj.status,
          addressLine: domicilioObj.addressLine || "",
          components: domicilioObj.components || {},
          updatedBy: "admin",
          updatedAt: nowTs(),
        };
      }

      if (isNew) {
        base.fcmTokens = [];
        base.createdAt = nowTs();
        base.updatedAt = nowTs();
      } else {
        base.updatedAt = nowTs();
      }
      return base;
    };

    if (!fsDocSnap.empty) {
      // existe → merge
      fsDocRef = fsDocSnap.docs[0].ref;
      const fsPayload = buildFsPayload(false);
      await fsDocRef.set(fsPayload, { merge: true });
    } else {
      // nuevo → docId opcional (MISMA LÓGICA ORIGINAL)
      fsDocRef = docId ? col.doc(docId) : col.doc();
      const newDoc = buildFsPayload(true);
      await fsDocRef.set(newDoc);
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
