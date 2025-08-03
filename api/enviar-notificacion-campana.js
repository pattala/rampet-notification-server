// api/enviar-notificacion-campana.js
import { verifySignature } from "@upstash/qstash/nextjs";

// (Aquí necesitas pegar toda la inicialización de firebase-admin y sendgrid,
// y la función completa 'procesarNotificacionIndividual' que teníamos
// en 'procesar-cola-notificaciones.js')

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { campaignId, tipoNotificacion, destinatarios } = req.body;
    
    // ¡LA MAGIA! Esta función llama a procesarNotificacionIndividual
    // que ya contiene toda la lógica de buscar clientes, plantillas y enviar.
    await procesarNotificacionIndividual({ campaignId, tipoNotificacion, destinatarios });

    res.status(200).json({ message: 'Notificación procesada.' });
  } catch (error) {
    console.error(`Error ejecutando envío para campaña:`, error);
    res.status(500).json({ error: 'Fallo al procesar la notificación.' });
  }
}

// Envolvemos nuestro handler con el verificador de QStash
export default verifySignature(handler);
