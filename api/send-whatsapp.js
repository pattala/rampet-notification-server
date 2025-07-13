const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Esta solución es para que la sesión de WhatsApp persista en Vercel.
// Usamos una variable global para mantener el cliente activo entre ejecuciones.
let client;
let clientStatus = 'UNINITIALIZED'; // Estado inicial
let qrCodeDataUrl = '';

function initializeWhatsApp() {
    if (client) {
        console.log("El cliente de WhatsApp ya está en proceso de inicialización.");
        return;
    }

    console.log('Inicializando nuevo cliente de WhatsApp...');
    clientStatus = 'INITIALIZING';
    
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: '/tmp' }), // Vercel permite escribir en la carpeta /tmp
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
    });

    client.on('qr', async (qr) => {
        console.log('QR RECIBIDO. Escanea el código con tu teléfono.');
        // Convertimos el QR a una imagen DataURL para poder mostrarla en el panel de admin
        qrCodeDataUrl = await qrcode.toDataURL(qr);
        clientStatus = 'QR_READY';
    });

    client.on('ready', () => {
        console.log('¡Cliente de WhatsApp está listo!');
        clientStatus = 'READY';
        qrCodeDataUrl = ''; // Ya no necesitamos el QR
    });

    client.on('auth_failure', msg => {
        console.error('FALLO DE AUTENTICACIÓN. Es posible que necesites escanear el QR de nuevo.', msg);
        clientStatus = 'AUTH_FAILURE';
        client = null; // Reseteamos para que se pueda reintentar
    });

    client.on('disconnected', (reason) => {
        console.log('Cliente desconectado. Intentando reconectar...', reason);
        clientStatus = 'DISCONNECTED';
        client = null; // Reseteamos para que se pueda reintentar
    });
    
    client.initialize().catch(err => {
        console.error("Error crítico durante la inicialización de WhatsApp:", err);
        clientStatus = "INIT_ERROR";
        client = null; // Reseteamos
    });
};

// Iniciar el cliente la primera vez que el servidor se carga
initializeWhatsApp();


// Esta es la función principal que Vercel ejecutará cuando se llame a /api/whatsapp
module.exports = async (req, res) => {
    // Configuración de CORS para permitir la comunicación con tu panel de admin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Usamos un parámetro en la URL para saber qué acción realizar
    const { action } = req.query;

    // Acción para verificar el estado del servicio y obtener el QR
    if (action === 'status') {
        if (!client && clientStatus !== 'INITIALIZING') {
            // Si por alguna razón el cliente se perdió, intentamos reiniciarlo
            initializeWhatsApp();
        }
        return res.status(200).json({ status: clientStatus, qr: qrCodeDataUrl });
    }
    
    // Acción para enviar un mensaje
    if (action === 'send') {
        if (clientStatus !== "READY") {
            return res.status(503).json({ success: false, error: "El servicio de WhatsApp no está listo. Verifica el estado y escanea el QR si es necesario." });
        }
        
        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ success: false, error: "Faltan los parámetros 'number' o 'message'." });
        }

        // Formato del número para la API: 5491123456789@c.us
        const chatId = `${number}@c.us`;

        try {
            await client.sendMessage(chatId, message);
            return res.status(200).json({ success: true, message: "Mensaje enviado." });
        } catch (error) {
            console.error("Error al enviar mensaje de WhatsApp:", error);
            return res.status(500).json({ success: false, error: "No se pudo enviar el mensaje. ¿Es un número de WhatsApp válido?" });
        }
    }
    
    return res.status(404).json({ error: "Acción no válida. Usa ?action=status o ?action=send" });
};
