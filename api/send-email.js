// api/send-email.js (VERSIÓN FINAL CON LÓGICA CORS CORREGIDA)
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const SENDER_EMAIL = "rampet.local@gmail.com";

module.exports = async (req, res) => {
    // ---- INICIO DE LA SOLUCIÓN CORS (AHORA AL PRINCIPIO) ----
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Si es la pregunta "pre-vuelo" (OPTIONS), respondemos OK y terminamos.
    // Esto es crucial para que el navegador permita la petición real.
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    // ---- FIN DE LA SOLUCIÓN CORS ----

    // ----- INICIO DEL BLOQUE DE SEGURIDAD (AHORA DESPUÉS DE CORS) -----
    // Este bloque solo se ejecuta para las peticiones POST, no para OPTIONS.
    const secretKey = process.env.API_SECRET_KEY;
    const providedKey = req.headers.authorization;

    if (!secretKey) {
        console.error("API_SECRET_KEY no está configurada en Vercel.");
        return res.status(500).json({ message: 'Error de configuración del servidor.' });
    }
    if (!providedKey || providedKey !== `Bearer ${secretKey}`) {
        return res.status(401).json({ message: 'Acceso no autorizado.' });
    }
    // ----- FIN DEL BLOQUE DE SEGURIDAD -----

    if (req.method !== 'POST') {
        return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
    }
    
    const { to, name } = req.body;

    if (!to || !name) {
        return res.status(400).json({ message: 'Petición inválida: Faltan email (to) o nombre (name).' });
    }
    
    const msg = {
        to: to,
        from: {
            name: 'Equipo RAMPET',
            email: SENDER_EMAIL,
        },
        subject: `¡Bienvenido a RAMPET, ${name}!`,
        html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
                <img src="https://raw.githubusercontent.com/pattala/rampet-cliente-app/main/images/mi_logo.png" alt="Logo de RAMPET" style="width: 150px; display: block; margin: 0 auto 20px auto;">
                <h2 style="color: #4A90E2;">¡Hola ${name}, te damos la bienvenida a RAMPET!</h2>
                <p>Estamos muy contentos de que te unas a nuestro programa de fidelización.</p>
                <p>A partir de ahora, acumularás puntos con cada compra que podrás canjear por increíbles premios.</p>
                <p>Puedes consultar tus puntos y los premios disponibles en nuestra aplicación web.</p>
                <br>
                <p>¡Gracias por ser parte de RAMPET!</p>
                <p><strong>El equipo de RAMPET</strong></p>
            </div>
        `,
    };

    try {
        await sgMail.send(msg);
        return res.status(200).json({ message: 'Email enviado correctamente.' });
    } catch (error) {
        console.error('Error al enviar el email con SendGrid:', error.response?.body || error);
        return res.status(500).json({ message: 'Error interno del servidor al intentar enviar el email.' });
    }
};
