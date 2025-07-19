// api/send-notification.js
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const messaging = admin.messaging();

function replacePlaceholders(template, data = {}) {
    let result = template;
    for (const key in data) {
        const regex = new RegExp(`{${key}}`, 'g');
        result = result.replace(regex, data[key]);
    }
    return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Solo se permite POST' });
  if (req.headers.authorization !== `Bearer ${process.env.API_SECRET_KEY}`) {
    return res.status(401).json({ message: 'No autorizado' });
  }

  // Ahora aceptamos 'templateId' y 'templateData'
  const { tokens, templateId, templateData } = req.body;
  if (!tokens || !Array.isArray(tokens) || tokens.length === 0 || !templateId) {
    return res.status(400).json({ error: 'Parámetros inválidos. Se requieren tokens y templateId.' });
  }

  try {
    const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
    if (!templateDoc.exists) {
      return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` });
    }
    const plantilla = templateDoc.data();

    const title = replacePlaceholders(plantilla.titulo, templateData);
    const body = replacePlaceholders(plantilla.cuerpo, templateData);

    const message = {
      notification: { title, body },
      tokens: tokens,
    };

    const response = await messaging.sendEachForMulticast(message);
    
    const successCount = response.successCount;
    const failureCount = response.failureCount;

    console.log(`Notificaciones enviadas: ${successCount} éxito(s), ${failureCount} fallo(s).`);

    return res.status(200).json({ 
      message: 'Operación completada.',
      successCount,
      failureCount 
    });
  } catch (error) {
    console.error('Error al enviar notificaciones:', error);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}
