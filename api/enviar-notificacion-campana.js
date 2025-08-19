// ====================================================================
// /api/enviar-notificacion-campana.js  (ESM, QStash + FCM WebPush + SendGrid)
// ====================================================================

import { verifySignature } from "@upstash/qstash/nextjs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import sgMail from "@sendgrid/mail";

// --- Init SendGrid ---
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// --- Init Firebase Admin (ESM) ---
if (!getApps().length) {
  const creds = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : null;
  initializeApp(creds ? { credential: cert(creds) } : {});
}

const db = getFirestore();
const messaging = getMessaging();

// Config opcional para íconos de push web
const PWA_URL   = process.env.PWA_URL || "https://rampet.vercel.app";
const ICON_URL  = process.env.PUSH_ICON_URL  || `${PWA_URL}/images/mi_logo.png`;
const BADGE_URL = process.env.PUSH_BADGE_URL || ICON_URL;

// --- Handler principal ---
async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

  try {
    const { campaignId, tipoNotificacion, destinatarios, templateId } =
      (typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}")) || {};

    if (!campaignId || !tipoNotificacion) {
      return res.status(400).json({ error: "Faltan campaignId o tipoNotificacion." });
    }

    await procesarNotificacionIndividual({ campaignId, tipoNotificacion, destinatarios, templateId });
    return res.status(200).json({ ok: true, message: "Notificación procesada." });
  } catch (err) {
    console.error("Error enviando notificación de campaña:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

export default verifySignature(handler);

// --------------------------------------------------------------------
// Lógica de envío
// --------------------------------------------------------------------
async function procesarNotificacionIndividual({ campaignId, tipoNotificacion, destinatarios, templateId }) {
  // 1) Campaña
  const snap = await db.collection("campanas").doc(String(campaignId)).get();
  if (!snap.exists) throw new Error(`Campaña ${campaignId} no encontrada`);
  const campana = snap.data();

  if (campana.estaActiva === false) {
    console.log(`Campaña ${campaignId} deshabilitada. No se envía.`);
    return;
  }

  // 2) Plantilla  (colección correcta = "plantillas")
  const tplId = templateId || (tipoNotificacion === "lanzamiento" ? "campaña_nueva_push" : "recordatorio_campana");
  const tplSnap = await db.collection("plantillas").doc(tplId).get();
  if (!tplSnap.exists) throw new Error(`Plantilla ${tplId} no encontrada`);
  const plantilla = tplSnap.data();

  // 3) Destinatarios (todos o grupo de prueba)
  let clientes = [];
  const all = await db.collection("clientes").where("numeroSocio", "!=", null).get();
  const arr = all.docs.map(d => ({ id: d.id, ...d.data() }));

  if (Array.isArray(destinatarios) && destinatarios.length) {
    clientes = arr.filter(c =>
      destinatarios.includes(String(c.numeroSocio)) || destinatarios.includes(c.email)
    );
  } else {
    clientes = arr;
  }

  // Filtrar suscritos a algo (email o push)
  const suscritos = clientes.filter(c => Boolean(c.email) || (Array.isArray(c.fcmTokens) && c.fcmTokens.length));
  if (!suscritos.length) {
    console.log("Sin destinatarios suscritos.");
    return;
  }

  // 4) Preparar textos (comunes)
  const textoVigencia =
    campana.fechaFin && campana.fechaFin !== "2100-01-01"
      ? `Aprovechá antes del ${new Date(campana.fechaFin).toLocaleDateString("es-AR")}.`
      : "¡Aprovechá los beneficios!";

  const subject = String(plantilla.titulo || "")
    .replace(/{nombre_campana}/g, campana.nombre);

  const cuerpoBase = String(plantilla.cuerpo || "")
    .replace(/{nombre_campana}/g, campana.nombre)
    .replace(/{cuerpo_campana}/g, campana.cuerpo || "")
    .replace(/{fecha_inicio}/g, new Date(campana.fechaInicio).toLocaleDateString("es-AR"))
    .replace(/\[TEXTO_VIGENCIA\]/g, textoVigencia);

  // 5) PUSH (WebPush con notification payload: visible con PWA cerrada)
  const tokens = [...new Set(suscritos.flatMap(c => c.fcmTokens || []))];
  if (tokens.length) {
    const bodyPush = cuerpoBase.replace(/<[^>]*>?/gm, " ").replace(/{nombre}/g, "cliente").trim();
    const msg = {
      tokens,
      data: {}, // si querés deep link, agregá claves como { screen: 'campanas' }
      webpush: {
        notification: {
          title: subject,
          body: bodyPush,
          icon: ICON_URL,
          badge: BADGE_URL
        },
        fcmOptions: { link: PWA_URL }
      }
    };

    const resp = await messaging.sendEachForMulticast(msg);
    console.log(`Push enviados: OK=${resp.successCount} ERR=${resp.failureCount}`);
    if (resp.failureCount) {
      console.log('Errores ejemplo:', resp.responses.filter(r => !r.success).slice(0,3));
    }
  }

  // 6) EMAILS (SendGrid)
  const emails = [...new Set(suscritos.map(c => c.email).filter(Boolean))];
  if (emails.length && process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL) {
    const jobs = emails.map(async (email) => {
      const cliente = suscritos.find(c => c.email === email);
      const nombre = cliente?.nombre?.split(" ")[0] || "Cliente";

      const html = `
        <div style="font-family:Arial, sans-serif; line-height:1.6; color:#333; max-width:600px; margin:auto; border:1px solid #ddd; padding:20px;">
          <img src="https://raw.githubusercontent.com/pattala/rampet-cliente-app/main/images/mi_logo.png" alt="Logo" style="width:150px; display:block; margin:0 auto 20px auto;">
          <h2 style="color:#0056b3;">${subject}</h2>
          <div>${cuerpoBase.replace(/{nombre}/g, nombre)}</div>
          <br><p>Atentamente,<br><strong>Club RAMPET</strong></p>
        </div>`.trim();

      try {
        await sgMail.send({
          to: email,
          from: { email: process.env.SENDGRID_FROM_EMAIL, name: "Club RAMPET" },
          subject,
          html
        });
      } catch (e) {
        console.error('SendGrid error ->', email, e?.response?.body || e);
      }
    });

    await Promise.allSettled(jobs);
    console.log(`Emails procesados: ${emails.length}`);
  } else {
    if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM_EMAIL) {
      console.log("SendGrid no configurado; se omiten emails.");
    }
  }
}
