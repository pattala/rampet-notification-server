// api/programar-lanzamiento.js
import { Client } from "@upstash/qstash";

const qstashClient = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  // Manejar CORS y método POST
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  
  // Seguridad básica (opcional pero recomendada)
  if (req.headers.authorization !== `Bearer ${process.env.API_SECRET_KEY}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const { campaignId, fechaNotificacion, destinatarios } = req.body;
    if (!campaignId || !fechaNotificacion) {
      return res.status(400).json({ error: 'Faltan campaignId o fechaNotificacion.' });
    }

    // URL de nuestra API de envío real
    const destinationUrl = `https://${process.env.VERCEL_URL}/api/enviar-notificacion-campana`;

    await qstashClient.publishJSON({
      url: destinationUrl,
      body: { campaignId, tipoNotificacion: 'lanzamiento', destinatarios },
      // Programar el envío para la fecha exacta (en segundos UNIX)
      notBefore: Math.floor(new Date(fechaNotificacion).getTime() / 1000),
    });

    res.status(202).json({ message: 'Lanzamiento programado con éxito.' });
  } catch (error) {
    console.error("Error programando en QStash:", error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
}
