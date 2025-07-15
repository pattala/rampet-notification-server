// api/send-email.js (VERSIÓN 100% FINAL CON CORS Y LOGO REAL)

// Se importa el módulo de SendGrid
const sgMail = require('@sendgrid/mail');

// Se configura la clave API desde las variables de entorno de Vercel
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Tu email verificado en SendGrid que funcionará como remitente
const SENDER_EMAIL = "rampet.local@gmail.com";

// Se exporta la función serverless
module.exports = async (req, res) => {
    // ---- INICIO DE LA SOLUCIÓN CORS ----
    // Estas cabeceras le dicen al navegador que esta API puede ser llamada desde cualquier origen.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // El navegador envía una petición "previa" (preflight) de tipo OPTIONS para verificar los permisos.
    // Si la petición es OPTIONS, simplemente respondemos que todo está OK y terminamos.
    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }
    // ---- FIN DE LA SOLUCIÓN CORS ----


    // Se valida que la petición sea de tipo POST
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
    }
    
    // Se extraen los datos del cuerpo de la petición
    const { to, name } = req.body;

    // Se valida que los datos necesarios hayan llegado
    if (!to || !name) {
        return res.status(400).json({ message: 'Petición inválida. El email (to) y el nombre (name) son requeridos.' });
    }
    
    // Se construye el objeto del mensaje del email
    const msg = {
        to: to,
        from: {
            name: 'Equipo RAMPET', // Puedes cambiar el nombre del remitente
            email: SENDER_EMAIL,
        },
        subject: `¡Bienvenido a RAMPET, ${name}!`, // El asunto del email
        html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
                
                <!-- Logo de la empresa -->
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

    // Se intenta enviar el email
    try {
        await sgMail.send(msg);
        return res.status(200).json({ message: 'Email enviado correctamente.' });
    } catch (error) {
        console.error('Error al enviar el email con SendGrid:', error);
        if (error.response) {
            console.error(error.response.body);
        }
        return res.status(500).json({ message: 'Error interno del servidor al intentar enviar el email.' });
    }
};
