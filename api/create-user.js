// api/create-user.js
// Alta de usuario (Auth + Firestore) con CORS + x-api-key + lectura de body segura.
// Idempotente y determinístico: el doc SIEMPRE es clientes/{authUID}.
// Incluye: persistir DNI (dni + dni_norm), admitir domicilio objeto/string y componer addressLine si faltara.

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
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

// ---------- Utils ----------
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
    return res.status(200).json({
      ok: true,
      route: "/api/create-user",
      corsOrigin: allowOrigin || null,
      project: "sistema-fidelizacion",
      tips: "POST con x-api-key y body { email, dni(password), nombre?, telefono?, numeroSocio?, fechaNacimiento?, fechaInscripcion?, domicilio? | direccion? }",
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
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON body" });
  }

  try {
    const db = getDb();

    // Campos esperados
    let {
      email, dni, nombre, telefono,
      numeroSocio, fechaNacimiento, fechaInscripcion,
      domicilio,      // objeto { status?, addressLine?, components? } o string
      direccion,      // string
      address         // string
    } = payload || {};

    if (!email || !dni) {
      return res.status(400).json({ ok: false, error: "Faltan campos obligatorios: email y dni" });
    }
    email = String(email).toLowerCase().trim();
    dni   = toStr(dni);
    if (dni.length < 6) {
      return res.status(400).json({ ok: false, error: "El DNI/clave debe tener al menos 6 caracteres" });
    }

    const dni_str  = dni;
    const dni_norm = dni_str.replace(/\D+/g, ""); // solo dígitos (para búsquedas)

    // 1) Auth (idempotente)
    initFirebaseAdmin();
    let authUser = null;
    let createdAuth = false;
    try {
      authUser = await admin.auth().getUserByEmail(email);
    } catch {
      // crear
      try {
        authUser = await admin.auth().createUser({
          email,
          password: dni,                 // password inicial = DNI (contrato actual)
          displayName: nombre || "",
          phoneNumber: telefono ? `+54${telefono}`.replace(/\D/g, "") : undefined,
          emailVerified: false,
          disabled: false,
        });
        createdAuth = true;
      } catch (e) {
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
          throw e;
        }
      }
    }
    const authUID = authUser.uid;

    // 2) Firestore (doc determinístico = clientes/{authUID})
    const col = db.collection("clientes");
    const clienteRef = col.doc(authUID);
    const snap = await clienteRef.get();
    const isNew = !snap.exists;

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

    const base = {
      email,
      nombre: isNew ? (nombre || "") : (nombre ?? admin.firestore.FieldValue.delete()),
      telefono: isNew ? (telefono || "") : (telefono ?? admin.firestore.FieldValue.delete()),
      numeroSocio: (numeroSocio != null)
        ? Number(numeroSocio)
        : (isNew ? null : admin.firestore.FieldValue.delete()),
      authUID,
      estado: "activo",
      dni: dni_str,
      dni_norm: dni_norm,
      updatedAt: nowTs(),
    };
    if (fechaNacimiento)  base.fechaNacimiento  = fechaNacimiento;
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
    if (isNew) {
      base.fcmTokens = [];
      base.createdAt = nowTs();
    }

    if (isNew) {
      await clienteRef.set(base, { merge: false });
    } else {
      await clienteRef.set(base, { merge: true });
    }

    return res.status(200).json({
      ok: true,
      auth: { uid: authUID, created: createdAuth },
      firestore: { docId: authUID, created: isNew }
    });

  } catch (err) {
    console.error("create-user error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
