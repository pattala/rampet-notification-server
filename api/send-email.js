//A api/send-email.js (Versión Final para SendGrid y Plantillas)

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sgMail = require('@sendgrid/mail');

// Configurar el API Key de SendGrid desde variables de entorno
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Cargar credenciales de Firebase desde variables de entorno
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

// Inicializar Firebase Admin SDK
try {
  initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
  if (e.code !== 'app/duplicate-app') {
    console.error('Firebase admin initialization error', e);
  }
}
const db = getFirestore();

// Función auxiliar para reemplazar variables
function replacePlaceholders(template, data = {}) {
    let result = template;
    for (const key in data) {
        result = result.replace(new RegExp(`{${key}}`, 'g'), data[key]);
    }
    return result;
}

// Handler principal de la API
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

  // Extraer los datos requeridos
  const { to, templateId, templateData } = req.body;
  if (!to || !templateId) {
    return res.status(400).json({ message: 'Faltan parámetros: to, templateId son requeridos.' });
  }

  try {
    // 1. Obtener la plantilla de Firestore
    const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
    if (!templateDoc.exists) {
        return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` });
    }
    const plantilla = templateDoc.data();

    // 2. Personalizar el contenido
    const subject = replacePlaceholders(plantilla.titulo, templateData);
    const body = replacePlaceholders(plantilla.cuerpo, templateData);
    
    // 3. Crear el cuerpo del email en formato HTML
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #0056b3;">${subject}</h2>
        <p>${body.replace(/\n/g, '<br>')}</p>
        <br>
        <p>Atentamente,</p>
        <p><strong>El equipo de Club RAMPET</strong></p>
      </div>
    `;

    // 4. Construir el mensaje para SendGrid
    const msg = {
      to: to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL, // Email verificado en SendGrid
        name: 'Club RAMPET'
      },
      subject: subject,
      html: htmlBody,
    };

    // 5. Enviar el email
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
