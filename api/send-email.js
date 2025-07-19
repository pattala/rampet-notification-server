// api/send-email.js
// --- CAMBIO 1: Importación selectiva ---
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
// --- FIN CAMBIO 1 ---
const nodemailer = require('nodemailer');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

// --- CAMBIO 2: Lógica de inicialización ---
try {
  initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
  // Ignorar el error si la app ya está inicializada
  if (e.code !== 'app/duplicate-app') {
    console.error('Firebase admin initialization error', e);
  }
}
const db = getFirestore();
// --- FIN CAMBIO 2 ---

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: true,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

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

    await transporter.sendMail({
      from: `"Club RAMPET" <${process.env.EMAIL_USER}>`,
      to: to,
      subject: subject,
      html: htmlBody,
    });
    
    return res.status(200).json({ message: 'Email enviado con éxito.' });
  } catch (error) {
    console.error('Error al procesar el envío de email:', error);
    return res.status(500).json({ message: 'Error interno del servidor.', error: error.message });
  }
}
