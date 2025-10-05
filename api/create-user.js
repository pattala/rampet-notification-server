// api/create-user.js
// Alta de usuario (Auth + Firestore) con CORS + x-api-key + body seguro.
// Idempotente. Si Auth falla, NO escribe Firestore.
// Aditivo: dni/dni_norm, domicilio objeto/string (compose addressLine).
// Diagnóstico: si headers['x-debug'] está presente, incluye datos de proyecto y detalle de errores.

import admin from "firebase-admin";

// ---------- Firebase Admin ----------
let SERVICE_ACCOUNT_CACHE = null;

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS_JSON missing");

  let sa;
  try { sa = JSON.parse(raw); }
  catch { throw new Error("Invalid GOOGLE_CREDENTIALS_JSON (not valid JSON)"); }

  SERVICE_ACCOUNT_CACHE = sa; // para devolver project_id en modo debug

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization, x-debug");
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

// ---------- Utils ----------
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

function toE164AR(phoneLike) {
  if (!phoneLike) return null;
  const digits = String(phoneLike).replace(/\D+/g, "");
  if (!digits) return null;
  const withCC = digits.startsWith("54") ? digits : ("54" + digits);
  const e164 = "+" + withCC;
  if (e164.length < 10 || e164.length > 16) return null;
  return e164;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  const allowOrigin = getAllowedOrigin(req);
  setCors(res, allowOrigin);

  const debug = !!req.headers["x-debug"];

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    initFirebaseAdmin();
    return res.status(200).json({
      ok: true,
      route: "/api/create-user",
      corsOrigin: allowOrigin || null,
      project: "sistema-fidelizacion",
      tips: "POST con x-api-key y body { email, dni(password), nombre?, telefono?, numeroSocio?, fechaNacimiento?, fechaInscripcion?, domicilio? }",
      debug: debug ? {
        adminApps: admin.apps.length,
        serviceAccountProjectId: SERVICE_ACCOUNT_CACHE?.project_id || null,
        allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || null)
      } : undefined
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

  // Campos esperados
  let {
    email, dni, nombre, telefono,
    numeroSocio, fechaNacimiento, fechaInscripcion,
    domicilio,      // objeto { status, addressLine?, components? } o string
    docId,          // opcional (para forzar ID)
    direccion,      // string (alias)
    address         // string (alias)
  } = payload || {};

  if (!email || !dni) {
    return res.status(400).json({ ok: false, error: "Faltan campos obligatorios: email y dni" });
  }
  email = String(email).toLowerCase().trim();
  dni   = toStr(dni);
  if (dni.length < 6) {
    return res.status(400).json({ ok: false, error: "El DNI/clave debe tener al menos 6 caracteres" });
  }

  // Preparar diagnóstico
  const diag = debug ? { attempts: [], serviceAccountProjectId: null } : null;

  try {
    initFirebaseAdmin();
    if (diag) diag.serviceAccountProjectId = SERVICE_ACCOUNT_CACHE?.project_id || null;

    // ---------- 1) AUTH ----------
    let authUser = null;
    let createdAuth = false;
    try {
      if (diag) diag.attempts.push("auth.getUserByEmail");
      authUser = await admin.auth().getUserByEmail(email);
    } catch (e1) {
      const maybePhone = toE164AR(telefono);
      try {
        if (diag) diag.attempts.push(`auth.createUser phone=${!!maybePhone}`);
        authUser = await admin.auth().createUser({
          email,
          password: dni,
          displayName: nombre || "",
          phoneNumber: maybePhone || undefined,
          emailVerified: false,
          disabled: false,
        });
        createdAuth = true;
      } catch (e2) {
        // Reintenta sin phone si falló por teléfono
        if (maybePhone) {
          try {
            if (diag) diag.attempts.push("auth.createUser no-phone");
            authUser = await admin.auth().createUser({
              email,
              password: dni,
              displayName: nombre || "",
              emailVerified: false,
              disabled: false,
            });
            createdAuth = true;
          } catch (e3) {
            if (diag) diag.authError = {
              step: "createUser no-phone",
              code: e3?.errorInfo?.code || e3?.code || null,
              message: e3?.errorInfo?.message || e3?.message || String(e3)
            };
            return res.status(500).json({ ok: false, error: "Auth creation failed", authError: diag?.authError });
          }
        } else {
          if (diag) diag.authError = {
            step: "createUser",
            code: e2?.errorInfo?.code || e2?.code || null,
            message: e2?.errorInfo?.message || e2?.message || String(e2)
          };
          return res.status(500).json({ ok: false, error: "Auth creation failed", authError: diag?.authError });
        }
      }
    }

    const authUID = authUser.uid;

    // ---------- 2) FIRESTORE ----------
    const db = getDb();
    const col = db.collection("clientes");

    // buscar por email; si existe, merge; si no, usar docId o crear nuevo
    const fsDocSnap = await col.where("email", "==", email).limit(1).get();
    let fsDocRef = null;
    let createdFs = false;

    // domicilio flexible
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

    const isNewPayload = (isNew) => {
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
        base.updatedAt = nowTs();
      } else {
        base.updatedAt = nowTs();
      }
      return base;
    };

    if (!fsDocSnap.empty) {
      fsDocRef = fsDocSnap.docs[0].ref;
      await fsDocRef.set(isNewPayload(false), { merge: true });
    } else {
      fsDocRef = docId ? col.doc(docId) : col.doc();
      await fsDocRef.set(isNewPayload(true), { merge: false });
      createdFs = true;
    }

    return res.status(200).json({
      ok: true,
      auth: { uid: authUID, created: createdAuth },
      firestore: { docId: fsDocRef.id, created: createdFs },
      debug: debug ? {
        adminApps: admin.apps.length,
        serviceAccountProjectId: SERVICE_ACCOUNT_CACHE?.project_id || null
      } : undefined
    });

  } catch (err) {
    // Si algo fuera de Auth truena
    const payload = { ok: false, error: "Internal Server Error" };
    if (debug) {
      payload.detail = err?.message || String(err);
      payload.serviceAccountProjectId = SERVICE_ACCOUNT_CACHE?.project_id || null;
    }
    return res.status(500).json(payload);
  }
}
