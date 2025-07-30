// /api/notify-campaign.js

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Inicialización de Firebase (como en los otros archivos)
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
try {
  initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
  if (e.code !== 'app/duplicate-app') console.error('Firebase init error', e);
}
const db = getFirestore();

/**
 * Función que llama a nuestras propias APIs de envío.
 * Esto nos permite reutilizar la lógica ya existente.
 * @param {string} endpoint El nombre del endpoint ('send-email' o 'send-notification').
 * @param {object} body El cuerpo de la petición para esa API.
 */
async function callInternalApi(endpoint, body) {
    const apiUrl = `${process.env.VERCEL_URL}/api/${endpoint}`;
    
    // Usamos fetch para llamar a nuestra propia API
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.API_SECRET_KEY}` // Nos autorizamos a nosotros mismos
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Error al llamar a la API interna ${endpoint}: ${response.status} ${errorBody}`);
    }

    return await response.json();
}


// --- Handler Principal de la API ---
export default async function handler(req, res) {
  // Configuración de CORS y método (igual que en tus otros archivos)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Solo se permite POST' });
  if (req.headers.authorization !== `Bearer ${process.env.API_SECRET_KEY}`) { return res.status(401).json({ message: 'No autorizado' }); }

  const { campaignId } = req.body;
  if (!campaignId) {
    return res.status(400).json({ error: 'Falta el ID de la campaña (campaignId).' });
  }

  try {
    // 1. Obtener los datos de la campaña recién creada
    const campaignDoc = await db.collection('campañas').doc(campaignId).get();
    if (!campaignDoc.exists) {
      return res.status(404).json({ error: 'Campaña no encontrada.' });
    }
    const campana = campaignDoc.data();

    // 2. Preparar los datos que usaremos en las plantillas de mensajes
    const templateData = {
        nombre_campana: campana.nombre,
        fecha_inicio_campana: new Date(campana.fechaInicio + 'T12:00:00Z').toLocaleDateString('es-ES', { timeZone: 'UTC' }),
        fecha_fin_campana: new Date(campana.fechaFin + 'T12:00:00Z').toLocaleDateString('es-ES', { timeZone: 'UTC' })
    };
    
    // 3. Obtener TODOS los clientes de la base de datos
    const clientesSnapshot = await db.collection('clientes').get();
    if (clientesSnapshot.empty) {
        return res.status(200).json({ message: 'No hay clientes para notificar.' });
    }

    // 4. Separar clientes para email y para notificaciones push
    const emailsToSend = [];
    let fcmTokensToSend = [];

    clientesSnapshot.forEach(doc => {
        const cliente = doc.data();
        if (cliente.email) {
            emailsToSend.push(cliente.email);
        }
        if (cliente.fcmTokens && cliente.fcmTokens.length > 0) {
            fcmTokensToSend.push(...cliente.fcmTokens);
        }
    });

    // Eliminamos duplicados por si un token está en varias fichas
    fcmTokensToSend = [...new Set(fcmTokensToSend)];

    console.log(`Iniciando envío para campaña '${campana.nombre}'. Clientes con email: ${emailsToSend.length}, Tokens Push: ${fcmTokensToSend.length}`);

    // 5. Enviar las notificaciones masivas llamando a nuestras propias APIs
    let emailResult = { message: "No se enviaron emails (ningún cliente con email)." };
    if (emailsToSend.length > 0) {
        for (const email of emailsToSend) {
            // Se envían uno por uno para no exceder límites y personalizar si fuera necesario
            await callInternalApi('send-email', {
                to: email,
                templateId: 'campaña_nueva_email',
                templateData: templateData
            });
        }
        emailResult = { message: `Tarea de envío de emails a ${emailsToSend.length} clientes completada.` };
    }
    
    let pushResult = { message: "No se enviaron notificaciones push (ningún cliente con token)." };
    if (fcmTokensToSend.length > 0) {
        pushResult = await callInternalApi('send-notification', {
            tokens: fcmTokensToSend,
            templateId: 'campaña_nueva_push',
            templateData: templateData
        });
    }

    // 6. Responder al panel de administrador que la tarea se completó
    return res.status(200).json({
      message: 'Operación de notificación de campaña completada.',
      emailResult,
      pushResult
    });

  } catch (error) {
    console.error('Error fatal en /api/notify-campaign:', error);
    return res.status(500).json({ error: 'Error interno del servidor.', details: error.message });
  }
}
