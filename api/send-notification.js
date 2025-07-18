//noti
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
try { initializeApp({ credential: cert(serviceAccount) }); } catch (e) { if (e.code !== 'app/duplicate-app') console.error('Firebase init error', e); }
const db = getFirestore();
const messaging = getMessaging();
function replacePlaceholders(template, data = {}) { let result = template; for (const key in data) { result = result.replace(new RegExp(`{${key}}`, 'g'), data[key]); } return result; }

export default async function handler(req, res) {
  // Dejamos las cabeceras aquí como redundancia
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
  
  // RESTAURAMOS el manejo explícito de OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method === 'POST') {
    try {
      if (req.headers.authorization !== `Bearer ${process.env.API_SECRET_KEY}`) {
        return res.status(401).json({ message: 'No autorizado' });
      }
      const { tokens, templateId, templateData, title: manualTitle, body: manualBody } = req.body;
      if (!tokens || !Array.isArray(tokens) || tokens.length === 0) { return res.status(400).json({ error: 'Se requiere un array de tokens.' }); }
      let title = '';
      let body = '';
      if (templateId) {
        const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
        if (!templateDoc.exists) { return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` }); }
        const plantilla = templateDoc.data();
        title = replacePlaceholders(plantilla.titulo, templateData);
        body = replacePlaceholders(plantilla.cuerpo, templateData);
      } else if (manualTitle && manualBody) {
        title = manualTitle;
        body = manualBody;
      } else {
        return res.status(400).json({ error: 'Se debe proporcionar "templateId" o "title" y "body".' });
      }
      const message = { notification: { title, body }, tokens };
      const response = await messaging.sendEachForMulticast(message);
      return res.status(200).json({ message: 'Operación completada.', successCount: response.successCount, failureCount: response.failureCount });
    } catch (error) {
      console.error('Error al enviar notificaciones:', error);
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  } else {
    return res.status(405).json({ message: `Método ${req.method} no permitido.` });
  }
}
