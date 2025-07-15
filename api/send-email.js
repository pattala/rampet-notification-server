// api/send-email.js (VERSIÓN FINAL CON CORS)

const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const SENDER_EMAIL = "rampet.local@gmail.com";

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


    // 1. Validar el método de la petición (ahora solo nos preocupamos por POST)
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
    }

    // 2. Extraer y validar los datos del cuerpo de la petición
    const { to, name } = req.body;

    if (!to || !name) {
        return res.status(400).json({ message: 'Petición inválida. El email (to) y el nombre (name) son requeridos.' });
    }

    // 3. Crear el contenido del email
    const msg = {
        to: to,
        from: {
            name: 'Equipo RAMPET',
            email: SENDER_EMAIL,
        },
        subject: `¡Bienvenido a RAMPET, ${name}!`,
        html: `
            <div style="font-family: Arial, sans-serif; color: #333;">
                <h2>¡Hola ${name}, te damos la bienvenida a RAMPET!</h2>
                <p>Estamos muy contentos de que te unas a nuestro programa de fidelización.</p>
                <p>A partir de ahora, acumularás puntos con cada compra que podrás canjear por increíbles premios.</p>
                <p>Puedes consultar tus puntos y los premios disponibles en nuestra aplicación web.</p>
                <br>
                <p>¡Gracias por ser parte de RAMPET!</p>
                <p><strong>El equipo de RAMPET</strong></p>
            </div>
        `,
    };

    // 4. Enviar el email y manejar la respuesta
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
