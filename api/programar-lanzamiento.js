// ====================================================================
// API: /api/programar-lanzamiento.js
// Propósito: Recibe una orden del panel y la programa en QStash.
// ====================================================================

import { Client } from "@upstash/qstash";
// --- CORS (copiar al inicio del archivo) ---
const ALLOWED = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}
// Inicializamos el cliente de QStash con el token de publicación
const qstashClient = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  // Manejo de CORS y validación del método

  if (cors(req, res)) return;
  if (req.method !== 'POST') { res.status(405).json({message:'Método no permitido'}); return; }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  
  // Seguridad: Verificamos que la llamada venga de nuestro panel
  if (req.headers.authorization !== `Bearer ${process.env.API_SECRET_KEY}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const { campaignId, fechaNotificacion, tipoNotificacion, destinatarios } = req.body;

    // Validación de datos de entrada
    if (!campaignId || !fechaNotificacion || !tipoNotificacion) {
      return res.status(400).json({ error: 'Faltan datos requeridos (campaignId, fechaNotificacion, tipoNotificacion).' });
    }

    // La URL de destino: nuestra otra API que hace el envío real
    const destinationUrl = `https://${req.headers.host}/api/enviar-notificacion-campana`;

    // Programamos el mensaje en QStash
    await qstashClient.publishJSON({
      // A dónde debe llamar QStash
      url: destinationUrl, 
      // Qué datos debe enviar en el cuerpo de la llamada
      body: { campaignId, tipoNotificacion, destinatarios },
      // Cuándo debe llamarla (en segundos UNIX)
      notBefore: Math.floor(new Date(fechaNotificacion).getTime() / 1000),
    });

    res.status(202).json({ message: `Trabajo de tipo '${tipoNotificacion}' programado con éxito.` });

  } catch (error) {
    console.error("Error programando en QStash:", error);
    res.status(500).json({ error: 'Error interno del servidor al programar la tarea.' });
  }
}
