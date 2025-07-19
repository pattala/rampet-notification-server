// api/send-notification.js (Versión Híbrida)

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// Cargar credenciales desde variables de entorno
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

// Inicializar Firebase Admin SDK (de forma segura para entornos serverless)
try {
  initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
  // Ignorar el error si la app ya ha sido inicializada
  if (e.code !== 'app/duplicate-app') {
    console.error('Firebase admin initialization error', e);
  }
}

// Obtener instancias de los servicios de Firebase
const db = getFirestore();
const messaging = getMessaging();

// Función auxiliar para reemplazar variables en plantillas
function replacePlaceholders(template, data = {}) {
    let result = template;
    for (const key in data) {
        result = result.replace(new RegExp(`{${key}}`, 'g'), data[key]);
    }
    return result;
}

// Handler principal de la API
export default async function handler(req, res) {
  // Configuración de CORS para permitir peticiones desde cualquier origen
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Manejar petición pre-vuelo de CORS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Validar que el método sea POST
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Solo se permite el método POST' });
  }

  // Validar la clave secreta de la API
  if (req.headers.authorization !== `Bearer ${process.env.API_SECRET_KEY}`) {
    return res.status(401).json({ message: 'No autorizado' });
  }

  // Extraer los datos del cuerpo de la petición
  const { tokens, templateId, templateData, title: manualTitle, body: manualBody } = req.body;

  // Validar que se hayan enviado tokens
  if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).json({ error: 'Se requiere un array de tokens.' });
  }

  let title = '';
  let body = '';

  try {
    // LÓGICA HÍBRIDA: Decide qué modo usar
    if (templateId) {
      // --- MODO PLANTILLA (para notificaciones automáticas) ---
      const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
      if (!templateDoc.exists) {
        return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` });
      }
      const plantilla = templateDoc.data();
      title = replacePlaceholders(plantilla.titulo, templateData);
      body = replacePlaceholders(plantilla.cuerpo, templateData);

    } else if (manualTitle && manualBody) {
      // --- MODO MANUAL (para envíos desde el panel de notificaciones) ---
      title = manualTitle;
      body = manualBody;

    } else {
      // Si no se proporciona ninguna de las dos opciones, es un error
      return res.status(400).json({ error: 'Se debe proporcionar "templateId" y "templateData", o "title" y "body".' });
    }

    // Construir el mensaje para FCM
    const message = {
      notification: { title, body },
      tokens: tokens,
    };

    // Enviar el mensaje a todos los tokens
    const response = await messaging.sendEachForMulticast(message);
    
    // Devolver una respuesta exitosa con el resumen del envío
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
