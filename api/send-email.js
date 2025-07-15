// api/send-email.js
import sgMail from '@sendgrid/mail';

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido' });
    }

    const { to, subject, html } = req.body;
    const text = "Este es un email automático del Club RAMPET. Para una mejor visualización, habilite el contenido HTML.";

    if (!to || !subject || !html) {
        return res.status(400).json({ error: 'Faltan datos requeridos (to, subject, html).' });
    }

    const msg = {
        to: to,
        from: 'rampet.local@gmail.com', // ¡Confirmado que este es tu email verificado!
        subject: subject,
        text: text,
        html: html,
    };

    try {
        await sgMail.send(msg);
        console.log('Email enviado con éxito a:', to);
        res.status(200).json({ success: true, message: 'Email enviado correctamente.' });
    } catch (error) {
        console.error('Error al enviar con SendGrid:', error.response?.body || error);
        res.status(500).json({ success: false, error: 'Error del servidor al enviar el email.' });
    }
}
