// api/send-email.js (Versión Final para SendGrid)

// --- Importación selectiva para reducir tamaño ---
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sgMail = require('@sendgrid/mail');

// --- Configuración de SendGrid ---
// Tu clave de API de SendGrid debe estar en las variables de entorno de Vercel
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- Configuración de Firebase Admin ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
try {
  // Inicializa la app solo si no ha sido inicializada antes
  initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
  // Ignora el error si la app ya existe, que es normal en entornos serverless
  if (e.code !== 'app/duplicate-app') {
    console.error('Firebase admin initialization error', e);
  }
}
const db = getFirestore();

// --- Función de reemplazo de variables ---
function replacePlaceholders(template, data = {}) {
    let result = template;
    for (const key in data) {
        const regex = new RegExp(`{${key}}`, 'g');
        result = result.replace(regex, data[key]);
    }
    return result;
}

// --- Handler principal de la API ---
export default async function handler(req, res) {
  // Configuración de CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Solo se permite POST' });
  if (req.headers.authorization !== `Bearer ${process.env.API_SECRET_KEY}`) {
    return res.status(401).json({ message: 'No autorizado' });
  }

  const { to, templateId, templateData } = req.body;
  if (!to || !templateId) {
    return res.status(400).json({ message: 'Faltan parámetros: to, templateId son requeridos.' });
  }

  try {
    const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
    if (!templateDoc.exists) {
        return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` });
    }
    const plantilla = templateDoc.data();

    const subject = replacePlaceholders(plantilla.titulo, templateData);
    const body = replacePlaceholders(plantilla.cuerpo, templateData);
    
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2>${subject}</h2>
        <p>${body.replace(/\n/g, '<br>')}</p><br>
        <p>Atentamente,<br><strong>El equipo de RAMPET</strong></p>
      </div>
    `;

    const msg = {
      to: to,
      // IMPORTANTE: Este debe ser un email que hayas verificado en tu cuenta de SendGrid
      from: {
        email: process.env.SENDGRID_FROM_EMAIL,
        name: 'Club RAMPET' // Puedes personalizar el nombre del remitente aquí
      },
      subject: subject,
      html: htmlBody,
    };

    await sgMail.send(msg);
    
    return res.status(200).json({ message: 'Email enviado con éxito a través de SendGrid.' });

  } catch (error) {
    console.error('Error al procesar el envío con SendGrid:', error);
    if (error.response) {
        console.error(error.response.body);
    }
    return res.status(500).json({ message: 'Error interno del servidor.', error: error.message });
  }
}
