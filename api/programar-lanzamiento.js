// ====================================================================
// API: /api/programar-lanzamiento
// Programa un envío de campaña en QStash
// CORS robusto + Auth por Bearer o x-api-key
// ====================================================================

import { Client } from "@upstash/qstash";

const qstashClient = new Client({ token: process.env.QSTASH_TOKEN || "" });

// ---- CORS ----
const ALLOWED = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-api-key");
  if (req.method === "OPTIONS") {
    // Preflight OK (sin body)
    res.status(204).end();
    return true;
  }
  return false;
}

// ---- Auth ----
function isAuthorized(req) {
  const apiKey = req.headers["x-api-key"] || null;
  if (apiKey && apiKey === process.env.API_SECRET_KEY) return true;

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token && token === process.env.API_SECRET_KEY) return true;

  // (Opcional) permitir si el origin está whitelisteado; comenta si no lo querés:
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) return true;

  return false;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "No autorizado" });
  }

  try {
    const {
      campaignId,
      fechaNotificacion,   // ISO string
      tipoNotificacion,    // 'lanzamiento' | 'recordatorio'
      destinatarios,       // opcional
      templateId,          // opcional (si querés validar/forwardear)
      templateData         // opcional
    } = req.body || {};

    if (!campaignId || !fechaNotificacion || !tipoNotificacion) {
      return res.status(400).json({
        error: "Faltan datos requeridos: campaignId, fechaNotificacion, tipoNotificacion",
      });
    }

    const when = Math.floor(new Date(fechaNotificacion).getTime() / 1000);
    if (!Number.isFinite(when) || when <= 0) {
      return res.status(422).json({ error: "fechaNotificacion inválida" });
    }

    // URL destino dentro del mismo proyecto (puede ser otra API tuya)
    const destinationUrl = `https://${req.headers.host}/api/enviar-notificacion-campana`;

    await qstashClient.publishJSON({
      url: destinationUrl,
      body: { campaignId, tipoNotificacion, destinatarios, templateId, templateData },
      notBefore: when,
    });

    return res.status(202).json({
      ok: true,
      message: `Trabajo '${tipoNotificacion}' programado`,
      when: fechaNotificacion,
    });
  } catch (err) {
    console.error("Error programando en QStash:", err);
    return res.status(500).json({ error: "Error interno al programar la tarea" });
  }
}
