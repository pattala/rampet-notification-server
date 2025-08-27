// /api/enviar-notificacion-campana.js
// QStash-ONLY (firma requerida) + FCM data-only + SendGrid
import { verifySignature } from "@upstash/qstash/nextjs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import sgMail from "@sendgrid/mail";

// ---------- Init SendGrid ----------
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// ---------- Init Firebase Admin ----------
if (!getApps().length) {
  const credsRaw = process.env.GOOGLE_CREDENTIALS_JSON || "";
  const creds = credsRaw ? JSON.parse(credsRaw) : null;
  initializeApp(creds ? { credential: cert(creds) } : {});
}
const db = getFirestore();
const messaging = getMessaging();

// ---------- Config opcional ----------
const PWA_URL   = process.env.PWA_URL || "https://rampet.vercel.app";
const ICON_URL  = process.env.PUSH_ICON_URL  || `${PWA_URL}/images/mi_logo.png`;
const BADGE_URL = process.env.PUSH_BADGE_URL || ICON_URL;

// ---------- Handler principal (QStash firma requerida) ----------
async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });

  try {
    const { campaignId, tipoNotificacion, destinatarios, templateId } =
      (typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}")) || {};

    if (!campaignId || !tipoNotificacion) {
      return res.status(400).json({ ok: false, error: "Faltan campaignId o tipoNotificacion." });
    }

    const result = await procesarNotificacionIndividual({ campaignId, tipoNotificacion, destinatarios, templateId });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("QStash campañas error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

export default verifySignature(handler);

// --------------------------------------------------------------------
// Lógica de envío (push data-only + emails HTML + inbox campañas)
// --------------------------------------------------------------------
async function procesarNotificacionIndividual({ campaignId, tipoNotificacion, destinatarios, templateId }) {
  // 1) Campaña
  const campSnap = await db.collection("campanas").doc(String(campaignId)).get();
  if (!campSnap.exists) throw new Error(`Campaña ${campaignId} no encontrada`);
  const campana = campSnap.data();

  if (campana.estaActiva === false) {
    return { skipped: true, reason: "Campaña deshabilitada" };
  }

  // 2) Plantilla
  const tplId = templateId || (tipoNotificacion === "lanzamiento" ? "campaña_nueva_push" : "recordatorio_campana");
  const tplSnap = await db.collection("plantillas").doc(tplId).get();
  if (!tplSnap.exists) throw new Error(`Plantilla ${tplId} no encontrada`);
  const plantilla = tplSnap.data();

  // 3) Destinatarios
  const all = await db.collection("clientes").where("numeroSocio", "!=", null).get();
  const todos = all.docs.map(d => ({ id: d.id, ...d.data() }));

  let clientes = todos;
  if (Array.isArray(destinatarios) && destinatarios.length) {
    const set = new Set(destinatarios.map(String));
    clientes = todos.filter(c => set.has(String(c.numeroSocio)) || set.has(String(c.email)));
  }

  // 4) Preparar textos
  const textoVigencia =
    campana.fechaFin && campana.fechaFin !== "2100-01-01"
      ? `Aprovechá antes del ${new Date(campana.fechaFin).toLocaleDateString("es-AR")}.`
      : "¡Aprovechá los beneficios!";

  const subject = String(plantilla.titulo || "").replace(/{nombre_campana}/g, campana.nombre);

  const cuerpoBase = String(plantilla.cuerpo || "")
    .replace(/{nombre_campana}/g, campana.nombre)
    .replace(/{cuerpo_campana}/g, campana.cuerpo || "")
    .replace(/{fecha_inicio}/g, new Date(campana.fechaInicio).toLocaleDateString("es-AR"))
    .replace(/\[TEXTO_VIGENCIA\]/g, textoVigencia);

  // 5) PUSH — data-only
  const tokens = Array.from(new Set(clientes.flatMap(c => c.fcmTokens || [])));
  let pushResp = null;
  if (tokens.length) {
    const bodyPush = cuerpoBase.replace(/<[^>]*>?/gm, " ").replace(/{nombre}/g, "cliente").trim();

    const data = {
      title: subject,
      body: bodyPush,
      icon: ICON_URL,
      url: `${PWA_URL}/notificaciones`,
      tag: `camp-${campaignId}`
    };

    pushResp = await messaging.sendEachForMulticast({ tokens, data });
    console.log(`Push data-only campañas: OK=${pushResp.successCount} ERR=${pushResp.failureCount}`);
  }

  // 6) EMAILS — SendGrid
  let emailCount = 0;
  if (process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL) {
    const emails = Array.from(new Set(clientes.map(c => c.email).filter(Boolean)));
    const jobs = emails.map(async (email) => {
      const cliente = clientes.find(c => c.email === email);
      const nombre  = cliente?.nombre?.split(" ")[0] || "Cliente";
      const html = `
        <div style="font-family:Arial, sans-serif; line-height:1.6; color:#333; max-width:600px; margin:auto; border:1px solid #ddd; padding:20px;">
          <img src="${ICON_URL}" alt="Logo" style="width:150px; display:block; margin:0 auto 20px 0;">
          <h2 style="color:#0056b3;">${subject}</h2>
          <div>${cuerpoBase.replace(/{nombre}/g, nombre)}</div>
          <br><p>Atentamente,<br><strong>Club RAMPET</strong></p>
        </div>
      `.trim();
      try {
        await sgMail.send({
          to: email,
          from: { email: process.env.SENDGRID_FROM_EMAIL, name: "Club RAMPET" },
          subject,
          html
        });
      } catch (e) {
        console.error("SendGrid error ->", email, e?.response?.body || e);
      }
    });
    const results = await Promise.allSettled(jobs);
    emailCount = results.length;
    console.log(`Emails procesados: ${emailCount}`);
  } else {
    console.log("SendGrid no configurado; se omiten emails.");
  }

  // 7) INBOX — crear entrada por campaña (campanita PWA)
  try {
    const now = new Date();
    const batch = db.batch();
    for (const c of clientes) {
      const inboxRef = db
        .collection('clientes')
        .doc(String(c.id))
        .collection('inbox')
        .doc();
      batch.set(inboxRef, {
        title: subject,
        body: cuerpoBase.replace(/<[^>]*>?/gm, ' ').trim(),
        url: `${PWA_URL}/notificaciones`,
        tag: `camp-${campaignId}`,
        source: 'campania',
        status: 'sent',
        sentAt: now,
        expireAt: campana.fechaFin && campana.fechaFin !== '2100-01-01' ? new Date(campana.fechaFin) : null
      });
    }
    await batch.commit();
  } catch (e) {
    console.error('Error creando inbox de campañas:', e);
  }

  return {
    push: pushResp ? { successCount: pushResp.successCount, failureCount: pushResp.failureCount } : null,
    emails: emailCount
  };
}
