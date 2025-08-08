// api/send-email.js (Versión Final ESM)

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import sgMail from '@sendgrid/mail';

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
            email: to,
            pwa_url: process.env.PWA_URL || '#',
            link_terminos: process.env.URL_TERMINOS_Y_CONDICIONES || '#'
        };
        
        body = body.replace(/\[BLOQUE_PUNTOS_BIENVENIDA\]([\s\S]*?)\[\/BLOQUE_PUNTOS_BIENVENIDA\]/g, 
            (_, block) => (fullTemplateData.puntos_ganados > 0) ? block : '');
            
        body = body.replace(/\[BLOQUE_CREDENCIALES_PANEL\]([\s\S]*?)\[\/BLOQUE_CREDENCIALES_PANEL\]/g, 
            (_, block) => fullTemplateData.creado_desde_panel ? block : '');

        for (const key in fullTemplateData) {
            body = body.replace(new RegExp('{' + key + '}', 'g'), fullTemplateData[key] || '');
            subject = subject.replace(new RegExp('{' + key + '}', 'g'), fullTemplateData[key] || '');
        }
        
        const htmlBody = `<div style="font-family: Arial, sans-serif; line-height: 1.6; max-width: 600px; margin: auto; padding: 20px;">
                            <img src="https://raw.githubusercontent.com/pattala/rampet-cliente-app/main/images/mi_logo.png" alt="Logo de RAMPET" style="width: 150px; display: block; margin: 0 auto 20px auto;">
                            <h2 style="color: #0056b3;">${subject}</h2>
                            <div>${body}</div><br>
                            <p>Atentamente,<br><strong>El equipo de Club RAMPET</strong></p>
                          </div>`;

        await sgMail.send({
            to: to, 
            from: { email: process.env.SENDGRID_FROM_EMAIL, name: 'Club RAMPET' },
            subject: subject, 
            html: htmlBody
        });
        return res.status(200).json({ message: 'Email enviado con éxito.' });
    } catch (error) {
        console.error('Error en send-email:', error);
        return res.status(500).json({ message: 'Error interno del servidor.', error: error.message });
    }
}
