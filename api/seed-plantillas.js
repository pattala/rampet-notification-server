// api/seed-plantillas.js
// Siembra plantillas (push + email) en Firestore en 1 sola llamada.
// Seguridad: requiere header 'x-api-key' = process.env.API_SECRET_KEY

import admin from "firebase-admin";

// --- Seguridad básica con API key ---
function assertAuth(req) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (!key || key !== process.env.API_SECRET_KEY) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
}

// --- Inicializar Firebase Admin con GOOGLE_CREDENTIALS_JSON ---
function initAdmin() {
  if (admin.apps.length) return admin;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw) {
    const err = new Error("Falta GOOGLE_CREDENTIALS_JSON en Vercel.");
    err.status = 500;
    throw err;
  }
  const creds = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(creds) });
  return admin;
}

// --- Helper para “texto plano push” (sin \n ni HTML) ---
function stripPush(text = "") {
  return String(text)
    .replace(/\\n|\\r/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Dataset de plantillas (UN SOLO LUGAR) ---
const plantillas = [
  {
    id: "puntos_ganados",
    descripcion: "Compra/bono: puntos sumados",
    titulo_push: "¡Sumaste nuevos puntos!",
    cuerpo_push:
      "¡Hola {nombre}! Sumaste {puntos_ganados} puntos {detalle_extra}. Ahora tenés {puntos_totales} puntos. [BLOQUE_VENCIMIENTO]Estos {puntos_vencen} puntos vencen el {vencimiento_text}.[/BLOQUE_VENCIMIENTO] ¡Gracias por preferirnos!",
    titulo_email: "¡Sumaste {puntos_ganados} puntos, {nombre}!",
    cuerpo_email:
      '<p>¡Hola {nombre}!</p><p>¡Sumaste <strong>{puntos_ganados}</strong> puntos {detalle_extra}!</p><p>Ahora tenés <strong>{puntos_totales}</strong> puntos.</p><h4>Puntos por vencer</h4>[BLOQUE_VENCIMIENTO]<p>Estos <strong><span style="color:#dc2626;">{puntos_vencen}</span></strong> puntos vencen el <strong>{vencimiento_text}</strong>.</p>[/BLOQUE_VENCIMIENTO]<p>¡Gracias por preferirnos!</p>',
    variables_sugeridas: [
      "nombre",
      "puntos_ganados",
      "puntos_totales",
      "detalle_extra",
      "puntos_vencen",
      "vencimiento_text",
    ],
  },
  {
    id: "premio_canjeado",
    descripcion: "Confirmación de canje",
    titulo_push: "¡Canje realizado con éxito!",
    cuerpo_push:
      "¡Hola {nombre}! Canjeaste {nombre_premio}. Gastaste {puntos_gastados} puntos. Tu saldo ahora es {puntos_totales}.",
    titulo_email: "Tu canje fue exitoso, {nombre}",
    cuerpo_email:
      "<p>¡Hola {nombre}!</p><p>Realizaste el canje del premio: <strong>{nombre_premio}</strong>.</p><p>Puntos gastados: <strong>{puntos_gastados}</strong></p><p>Puntos restantes: <strong>{puntos_totales}</strong></p><p>¡Gracias por participar!</p>",
    variables_sugeridas: [
      "nombre",
      "nombre_premio",
      "puntos_gastados",
      "puntos_totales",
    ],
  },
  {
    id: "campaña_nueva_push",
    descripcion: "Anuncio de nueva campaña/promoción",
    titulo_push: "📢 ¡Nueva campaña!",
    cuerpo_push: "{titulo} — {descripcion} Válido hasta: {vence_text}.",
    titulo_email: "Nueva campaña: {titulo}",
    cuerpo_email:
      "<p>¡Hola {nombre}!</p><p><strong>{titulo}</strong></p><p>{descripcion}</p><p>Válido hasta: <strong>{vence_text}</strong></p>",
    variables_sugeridas: ["nombre", "titulo", "descripcion", "vence_text"],
  },
  {
    id: "recordatorio_campana",
    descripcion: "Recordatorio de campaña/promoción",
    titulo_push: "⏰ Recordatorio de campaña",
    cuerpo_push: "{titulo} — {descripcion} Válido hasta: {vence_text}.",
    titulo_email: "Recordatorio de campaña: {titulo}",
    cuerpo_email:
      "<p>¡Hola {nombre}!</p><p><strong>{titulo}</strong></p><p>{descripcion}</p><p>Válido hasta: <strong>{vence_text}</strong></p>",
    variables_sugeridas: ["nombre", "titulo", "descripcion", "vence_text"],
  },
  {
    id: "compra",
    descripcion: "Confirmación de compra con puntos acreditados",
    titulo_push: "¡Compra registrada!",
    cuerpo_push:
      "¡Hola {nombre}! Registramos tu compra. Sumaste {puntos_ganados} puntos. Ahora tenés {puntos_totales} puntos. [BLOQUE_VENCIMIENTO]Estos {puntos_vencen} puntos vencen el {vencimiento_text}.[/BLOQUE_VENCIMIENTO]",
    titulo_email: "Tu compra fue registrada, {nombre}",
    cuerpo_email:
      '<p>¡Hola {nombre}!</p><p>Registramos tu compra y acreditamos <strong>{puntos_ganados}</strong> puntos.</p><p>Tu nuevo saldo es <strong>{puntos_totales}</strong> puntos.</p>[BLOQUE_VENCIMIENTO]<p>De esos, <strong><span style="color:#dc2626;">{puntos_vencen}</span></strong> vencen el <strong>{vencimiento_text}</strong>.</p>[/BLOQUE_VENCIMIENTO]',
    variables_sugeridas: [
      "nombre",
      "importe_compra",
      "puntos_ganados",
      "puntos_totales",
      "puntos_vencen",
      "vencimiento_text",
      "detalle_extra",
    ],
  },
  {
    id: "bienvenida",
    descripcion: "Mensaje de bienvenida y credenciales",
    titulo_push: "¡Bienvenido/a al Club RAMPET!",
    cuerpo_push:
      "¡Hola {nombre}! Tu número de socio es {numero_socio}. [BLOQUE_PUNTOS_BIENVENIDA]Sumaste {puntos_ganados} puntos de bienvenida.[/BLOQUE_PUNTOS_BIENVENIDA] Instalá la app para seguir tus puntos: {pwa_url}",
    titulo_email: "¡Bienvenido/a al Club RAMPET!",
    cuerpo_email:
      '<p>Hola {nombre},</p><p>¡Te damos la bienvenida al Club RAMPET! Tu número de socio es el <b>{numero_socio}</b>.</p>[BLOQUE_PUNTOS_BIENVENIDA]<p style="background-color: #e0f2fe; border-left: 5px solid #0ea5e9; padding: 15px; margin: 15px 0;">¡Además, para empezar con todo, hemos añadido <b>{puntos_ganados} puntos de bienvenida</b> a tu cuenta!</p>[/BLOQUE_PUNTOS_BIENVENIDA]<p>Para consultar tus puntos, ver las últimas novedades y acceder a ofertas exclusivas, te recomendamos instalar nuestra aplicación web en tu celular o computadora ¡Es muy fácil!</p><table width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0;"><tr><td><table cellspacing="0" cellpadding="0" style="margin:0 auto;"><tr><td align="center" style="background-color: #007bff; border-radius: 5px;"><a href="{pwa_url}" target="_blank" style="font-size: 16px; color: #ffffff; text-decoration: none; display: inline-block; padding: 12px 25px; border-radius: 5px; font-weight: bold;">Acceder a la App</a></td></tr></table></td></tr></table>[BLOQUE_CREDENCIALES_PANEL]<div style="border: 1px solid #ccc; padding: 15px; margin-top: 15px; background-color: #f8f9fa; border-radius: 5px;"><h4 style="margin-top:0;">Datos de Acceso Iniciales:</h4><p style="margin: 5px 0;"><b>Usuario:</b> {email}</p><p style="margin: 5px 0;"><b>Contraseña:</b> Tu número de DNI</p><p style="font-size:12px; color:#666; margin-top:10px;">Por seguridad, te recomendamos cambiar tu contraseña desde la aplicación una vez que ingreses.</p></div>[/BLOQUE_CREDENCIALES_PANEL]<p style="font-size:14px; color:#666;">Al registrarte, aceptas nuestros <a href="{link_terminos}" style="color: #007bff; text-decoration: none;">Términos y Condiciones</a>.</p><p>¡Te esperamos!</p>',
    variables_sugeridas: [
      "nombre",
      "numero_socio",
      "puntos_ganados",
      "pwa_url",
      "email",
      "link_terminos",
      "puntos_vencen",
      "vencimiento_text",
    ],
  },
  {
    id: "oferta_express",
    descripcion: "Oferta relámpago / oportunidad de compra inmediata",
    titulo_push: "🔥 Oferta Express",
    cuerpo_push: "{titulo} — {descripcion} Válido hasta: {vence_text}.",
    titulo_email: "Oferta Express: {titulo}",
    cuerpo_email:
      "<p>¡Hola {nombre}!</p><p><strong>{titulo}</strong></p><p>{descripcion}</p><p>Válido hasta: <strong>{vence_text}</strong></p>",
    variables_sugeridas: ["nombre", "titulo", "descripcion", "vence_text"],
  },
];

// --- Handler ---
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    assertAuth(req);
    const { mode = "both", dryRun = false } = req.body || {}; // mode: 'unified' | 'legacy' | 'both'

    const app = initAdmin();
    const db = app.firestore();

    const results = [];
    for (const p of plantillas) {
      const unifiedDoc = {
        descripcion: p.descripcion,
        titulo_push: p.titulo_push,
        cuerpo_push: p.cuerpo_push,
        titulo_email: p.titulo_email,
        cuerpo_email: p.cuerpo_email,
        variables_sugeridas: p.variables_sugeridas,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const legacyEmail = {
        titulo: p.titulo_email,
        cuerpo: p.cuerpo_email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const legacyPush = {
        titulo_push: stripPush(p.titulo_push),
        cuerpo_push: stripPush(p.cuerpo_push),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!dryRun && (mode === "both" || mode === "unified")) {
        await db.collection("plantillas").doc(p.id).set(unifiedDoc, { merge: true });
      }
      if (!dryRun && (mode === "both" || mode === "legacy")) {
        await db.collection("plantillas_mensajes").doc(p.id).set(legacyEmail, { merge: true });
        await db.collection("plantillas_push").doc(p.id).set(legacyPush, { merge: true });
      }

      results.push({ id: p.id, wrote: dryRun ? "dry-run" : mode });
    }

    return res.status(200).json({ ok: true, mode, dryRun, count: results.length, results });
  } catch (err) {
    console.error(err);
    const status = err.status || 500;
    return res.status(status).json({ ok: false, error: err.message || "Unknown error" });
  }
