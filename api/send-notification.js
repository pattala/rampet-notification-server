// api/send-notification.js (VERSIÓN FINAL CON LÓGICA DE VENCIMIENTO)

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

try {
  initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
  if (e.code !== 'app/duplicate-app') console.error('Firebase init error', e);
}
const db = getFirestore();
const messaging = getMessaging();

// ---> Se elimina la antigua función replacePlaceholders

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Solo se permite POST' });
  if (req.headers.authorization !== `Bearer ${process.env.API_SECRET_KEY}`) { return res.status(401).json({ message: 'No autorizado' }); }

  const { tokens, templateId, templateData, title: manualTitle, body: manualBody } = req.body;
  if (!tokens || !Array.isArray(tokens) || tokens.length === 0) { return res.status(400).json({ error: 'Se requiere un array de tokens.' }); }

  let title = '';
  let body = '';

  try {
    if (templateId) {
      const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
      if (!templateDoc.exists) { return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` }); }
      
      const plantilla = templateDoc.data();
      title = plantilla.titulo;
      body = plantilla.cuerpo;

      // ---> INICIO DE LA NUEVA LÓGICA
      // 1. Lógica para construir el texto de vencimiento
      let textoBloqueVencimiento = ''; // Por defecto, vacío
      if (templateData && templateData.puntos_por_vencer && templateData.puntos_por_vencer > 0 && templateData.fecha_vencimiento) {
          // Para notificaciones push, usamos un texto simple y directo.
          textoBloqueVencimiento = ` ¡Atención! ${templateData.puntos_por_vencer} de tus puntos vencen el ${templateData.fecha_vencimiento}.`;
      }
      // 2. Reemplazamos el marcador de posición
      body = body.replace('[BLOQUE_VENCIMIENTO]', textoBloqueVencimiento);

      // 3. Reemplazamos el resto de las variables de forma segura
      if (templateData) {
        for (const key in templateData) {
          const regex = new RegExp(`{${key}}`, 'g');
          body = body.replace(regex, templateData[key] || '');
          title = title.replace(regex, templateData[key] || '');
        }
      }
      // ---> FIN DE LA NUEVA LÓGICA

    } else if (manualTitle && manualBody) {
      // Para notificaciones manuales, no hay lógica de plantillas
      title = manualTitle;
      body = manualBody;
    } else {
      return res.status(400).json({ error: 'Se debe proporcionar "templateId" o "title" y "body".' });
    }

    // El cuerpo del mensaje de una notificación push no puede ser HTML.
    // Si la plantilla contiene HTML, lo limpiamos para que solo quede el texto.
    const cleanBody = body.replace(/<[^>]*>?/gm, ' '); // Elimina etiquetas HTML
    
    const message = {
      data: {
        title: title,
        body: cleanBody, // Enviamos el texto limpio
      },
      tokens: tokens,
    };

    const response = await messaging.sendEachForMulticast(message);
    
    return res.status(200).json({ 
      message: 'Operación completada.',
      successCount: response.successCount,
      failureCount: response.failureCount 
    });

  } catch (error) {
    console.error('Error al enviar notificaciones:', error);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}
