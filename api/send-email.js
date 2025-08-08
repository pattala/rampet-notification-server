// api/send-email.js (VERSIÓN FINAL CORREGIDA Y LIMPIA)

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- Inicialización Segura de Firebase ---
try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
    if (e.code !== 'app/duplicate-app') {
        console.error('Error inicializando Firebase Admin SDK:', e);
    }
}
const db = getFirestore();

// --- Función Principal de la API ---
export default async function handler(req, res) {
    // Las cabeceras CORS ahora son gestionadas por vercel.json
    // RE-INTRODUCIDO: Manejo de OPTIONS para un cortocircuito seguro.
    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ message: `Método ${req.method} no permitido.` });
    }

    try {
        // --- LÓGICA DE AUTORIZACIÓN MEJORADA ---
        const providedToken = req.headers.authorization?.split('Bearer ')[1];
        if (!providedToken || providedToken !== process.env.API_SECRET_KEY) {
            console.warn('Intento de acceso no autorizado a send-email API.');
            return res.status(401).json({ message: 'No autorizado.' });
        }

        const { to, templateId, templateData } = req.body;
        if (!to || !templateId) {
            return res.status(400).json({ message: 'Faltan parámetros: to, templateId son requeridos.' });
        }

        const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
        if (!templateDoc.exists) {
            return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` });
        }

        const plantilla = templateDoc.data();
        let subject = plantilla.titulo || 'Notificación de Club RAMPET';
        let body = plantilla.cuerpo || '';

        // Reemplazo de variables seguro
        if (templateData) {
            for (const key in templateData) {
                // Usamos una RegEx más simple y segura para reemplazar {variable}
                const regex = new RegExp('{' + key + '}', 'g');
                body = body.replace(regex, templateData[key] || '');
                subject = subject.replace(regex, templateData[key] || '');
            }
        }
        
        // Reemplazo de marcadores especiales como [BLOQUE_VENCIMIENTO]
        let htmlBloqueVencimiento = '';
        if (templateData && templateData.puntos_por_vencer > 0 && templateData.fecha_vencimiento) {
             htmlBloqueVencimiento = `<div style="border: 1px solid #ffc107; padding: 10px; margin-top: 15px; background-color: #fff3cd; border-radius: 5px;"> <p style="margin: 0;"><b>¡Atención!</b> Tienes <b>${templateData.puntos_por_vencer} puntos</b> que están próximos a vencer el día <b>${templateData.fecha_vencimiento}</b>. ¡No dejes que se pierdan!</p> </div>`;
        }
        body = body.replace('[BLOQUE_VENCIMIENTO]', htmlBloqueVencimiento);


        // Estructura del Email
        const htmlBody = `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
                            <img src="https://raw.githubusercontent.com/pattala/rampet-cliente-app/main/images/mi_logo.png" alt="Logo de RAMPET" style="width: 150px; display: block; margin: 0 auto 20px auto;">
                            <h2 style="color: #0056b3;">${subject}</h2>
                            <div>${body.replace(/\n/g, '<br>')}</div>
                            <br>
                            <p>Atentamente,<br><strong>El equipo de Club RAMPET</strong></p>
                          </div>`;

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
        console.error('Error fatal al procesar el envío de email:', error);
        if (error.response) { console.error(error.response.body); }
        return res.status(500).json({ message: 'Error interno del servidor.', error: error.message });
    }
}
