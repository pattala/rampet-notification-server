// api/send-email.js (VERSIÓN FINAL CON LÓGICA DE VENCIMIENTO)
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
try {
initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
if (e.code !== 'app/duplicate-app') console.error('Firebase init error', e);
}
const db = getFirestore();
// ---> CAMBIO 1: Se elimina la función replacePlaceholders. La reemplazaremos por una más potente.
// Función principal de la API (Serverless Function)
export default async function handler(req, res) {
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Credentials', true);
res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
if (req.method === 'OPTIONS') {
return res.status(200).end();
}
if (req.method === 'POST') {
try {
code
Code
download
content_copy
expand_less
IGNORE_WHEN_COPYING_START
IGNORE_WHEN_COPYING_END
if (req.headers.authorization !== Bearer ${process.env.API_SECRET_KEY}) {
return res.status(401).json({ message: 'No autorizado' });
}
const { to, templateId, templateData } = req.body;
if (!to || !templateId) {
return res.status(400).json({ message: 'Faltan parámetros: to, templateId son requeridos.' });
}
const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
if (!templateDoc.exists) {
return res.status(404).json({ message: Plantilla '${templateId}' no encontrada. });
}
const plantilla = templateDoc.data();
let subject = plantilla.titulo;
let body = plantilla.cuerpo;
// ---> CAMBIO 2: Lógica para construir el bloque de vencimiento
let htmlBloqueVencimiento = ''; // Por defecto, es un texto vacío
// Si la data que llegó del panel tiene puntos por vencer y una fecha, creamos el HTML
if (templateData && templateData.puntos_por_vencer && templateData.puntos_por_vencer > 0 && templateData.fecha_vencimiento) {
htmlBloqueVencimiento = <div style="border: 1px solid #ffc107; padding: 10px; margin-top: 15px; background-color: #fff3cd; border-radius: 5px;"> <p style="margin: 0;"><b>¡Atención!</b> Tienes <b>${templateData.puntos_por_vencer} puntos</b> que están próximos a vencer el día <b>${templateData.fecha_vencimiento}</b>. ¡No dejes que se pierdan!</p> </div>;
}
// Reemplazamos el marcador de posición con nuestro bloque (que puede estar vacío o lleno)
body = body.replace('[BLOQUE_VENCIMIENTO]', htmlBloqueVencimiento);
// ---> CAMBIO 3: Nueva forma de reemplazar el resto de las variables de forma segura
if (templateData) {
for (const key in templateData) {
const regex = new RegExp({${key}}, 'g');
body = body.replace(regex, templateData[key] || '');
subject = subject.replace(regex, templateData[key] || '');
}
}
// HTML CON EL FORMATO PROFESIONAL Y EL LOGO
const htmlBody = <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;"> <img src="https://raw.githubusercontent.com/pattala/rampet-cliente-app/main/images/mi_logo.png" alt="Logo de RAMPET" style="width: 150px; display: block; margin: 0 auto 20px auto;"> <h2 style="color: #0056b3;">${subject}</h2> <div>${body.replace(/\n/g, '<br>')}</div> <br> <p>Atentamente,<br><strong>El equipo de Club RAMPET</strong></p> </div>;
// ---> Nota: He envuelto el "body" en un <div> para mejor consistencia del HTML
const msg = {
to: to,
from: {
email: process.env.SENDGRID_FROM_EMAIL,
name: 'Club RAMPET'
},
subject: subject,
html: htmlBody
};
await sgMail.send(msg);
return res.status(200).json({ message: 'Email enviado con éxito.' });
} catch (error) {
console.error('Error al procesar el envío:', error);
if (error.response) { console.error(error.response.body); }
return res.status(500).json({ message: 'Error interno del servidor.', error: error.message });
}
} else {
return res.status(405).json({ message: Método ${req.method} no permitido. });
}
}
