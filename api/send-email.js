// api/send-email.js (VERSIÓN FINAL CON CREDENCIALES DINÁMICAS)

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
    if (e.code !== 'app/duplicate-app') { console.error('Firebase init error:', e); }
}
const db = getFirestore();

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') { return res.status(204).send(''); }
    if (req.method !== 'POST') { return res.status(405).json({ message: `Método ${req.method} no permitido.` }); }

    try {
        const providedToken = req.headers.authorization?.split('Bearer ')[1];
        if (!providedToken || providedToken !== process.env.API_SECRET_KEY) {
            return res.status(401).json({ message: 'No autorizado.' });
        }

        const { to, templateId, templateData } = req.body;
        if (!to || !templateId) {
            return res.status(400).json({ message: 'Faltan parámetros: to, templateId son requeridos.' });
        }

        const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
        if (!templateDoc.exists) { return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` }); }

        const plantilla = templateDoc.data();
        let subject = plantilla.titulo || 'Notificación de Club RAMPET';
        let body = plantilla.cuerpo || '';
        
        const fullTemplateData = {
            ...templateData,
            email: to, // Añadimos el email para poder usarlo en la plantilla
            pwa_url: process.env.PWA_URL || '#',
            link_terminos: process.env.URL_TERMINOS_Y_CONDICIONES || '#'
        };
        
        // Procesamos bloque de PUNTOS
        body = body.replace(/\[BLOQUE_PUNTOS_BIENVENIDA\]([\s\S]*?)\[\/BLOQUE_PUNTOS_BIENVENIDA\]/g, (match, blockContent) => {
            return (fullTemplateData.puntos_ganados && fullTemplateData.puntos_ganados > 0) ? blockContent : '';
        });

        // Procesamos bloque de CREDENCIALES
        body = body.replace(/\[BLOQUE_CREDENCIALES_PANEL\]([\s\S]*?)\[\/BLOQUE_CREDENCIALES_PANEL\]/g, (match, blockContent) => {
            // Si la bandera 'creado_desde_panel' es true, dejamos el bloque. Si no, lo eliminamos.
            return fullTemplateData.creado_desde_panel ? blockContent : '';
        });

        // Reemplazamos todas las variables {variable}
        for (const key in fullTemplateData) {
            const regex = new RegExp('{' + key + '}', 'g');
            body = body.replace(regex, fullTemplateData[key] || '');
            subject = subject.replace(regex, fullTemplateData[key] || '');
        }
        
        const htmlBody = `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
                            <img src="https://raw.githubusercontent.com/pattala/rampet-cliente-app/main/images/mi_logo.png" alt="Logo de RAMPET" style="width: 150px; display: block; margin: 0 auto 20px auto;">
                            <h2 style="color: #0056b3;">${subject}</h2>
                            <div>${body}</div>
                            <br>
                            <p>Atentamente,<br><strong>El equipo de Club RAMPET</strong></p>
                          </div>`;

        const msg = {
            to: to, from: { email: process.env.SENDGRID_FROM_EMAIL, name: 'Club RAMPET' },
            subject: subject, html: htmlBody
        };

        await sgMail.send(msg);
        return res.status(200).json({ message: 'Email enviado con éxito.' });

    } catch (error) {
        console.error('Error fatal al procesar el envío de email:', error);
        if (error.response) { console.error(error.response.body); }
        return res.status(500).json({ message: 'Error interno del servidor.', error: error.message });
    }
}
