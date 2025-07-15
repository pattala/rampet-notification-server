// api/send-email.js (CORREGIDO - USA COMMONJS)

// Usamos require para importar el módulo en un entorno CommonJS
const sgMail = require('@sendgrid/mail');

// Configurar la clave API desde las variables de entorno de Vercel
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// El "Single Sender" verificado en SendGrid
const SENDER_EMAIL = "rampet.local@gmail.com";

/**
 * Handler para la función serverless de Vercel.
 * Se exporta con module.exports para ser compatible con el entorno por defecto de Vercel.
 */
module.exports = async (req, res) => {
    // 1. Validar el método de la petición
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
    }

    // 2. Extraer y validar los datos del cuerpo de la petición
    // Vercel parsea automáticamente el body si el Content-Type es application/json
    const { to, name } = req.body;

    if (!to || !name) {
        return res.status(400).json({ message: 'Petición inválida. El email (to) y el nombre (name) son requeridos en el cuerpo de la solicitud.' });
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
        
        // Si SendGrid devuelve información de error, la mostramos en los logs del servidor
        if (error.response) {
            console.error(error.response.body);
        }
        
        return res.status(500).json({ message: 'Error interno del servidor al intentar enviar el email.' });
    }
};
