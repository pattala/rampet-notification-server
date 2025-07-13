// api/send-whatsapp.js (VERSIÓN FINAL Y ROBUSTA)

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Usamos el objeto 'global' de Node.js para intentar persistir el cliente
// entre invocaciones "calientes" de la función en Vercel.
if (typeof global.waClient === 'undefined') {
    global.waClient = null;
    global.qrCodeData = null;
    global.clientStatus = 'UNINITIALIZED';
}

const initializeClient = () => {
    // Evita reinicializar si ya está en proceso o listo
    if (global.waClient || global.clientStatus === 'INITIALIZING') {
        console.log('Inicialización ya en progreso o completada. Estado:', global.clientStatus);
        return;
    }

    console.log('Inicializando nuevo cliente de WhatsApp...');
    global.clientStatus = 'INITIALIZING';

    global.waClient = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    });

    global.waClient.on('qr', (qr) => {
        console.log('QR Recibido. Escanee para autenticar.');
        global.qrCodeData = qr;
        global.clientStatus = 'QR_READY';
    });

    global.waClient.on('ready', () => {
        console.log('¡Cliente de WhatsApp está listo!');
        global.qrCodeData = null;
        global.clientStatus = 'READY';
    });

    global.waClient.on('disconnected', (reason) => {
        console.log('Cliente desconectado:', reason);
        global.waClient = null;
        global.clientStatus = 'UNINITIALIZED';
    });

    global.waClient.initialize().catch(err => {
        console.error("Error catastrófico durante la inicialización:", err);
        global.waClient = null;
        global.clientStatus = 'ERROR';
    });
};

module.exports = async (req, res) => {
    // Configuración de CORS para cada respuesta
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // --- INICIO DE LA CORRECCIÓN CLAVE ---
    // Leemos 'action' tanto de la query string (para GET) como del body (para POST)
    const action = req.query.action || (req.body && req.body.action);
    // --- FIN DE LA CORRECCIÓN CLAVE ---

    // Siempre intenta inicializar si no está listo
    if (!global.waClient && global.clientStatus !== 'INITIALIZING') {
        initializeClient();
    }
    
    if (action === 'status') {
        return res.status(200).json({ status: global.clientStatus, qr: global.qrCodeData });
    }

    if (action === 'send') {
        if (global.clientStatus !== 'READY') {
            return res.status(400).json({ success: false, error: 'Cliente de WhatsApp no está listo.' });
        }
        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ success: false, error: 'Faltan número o mensaje.' });
        }
        const chatId = `${number.replace(/\D/g, '')}@c.us`;
        try {
            await global.waClient.sendMessage(chatId, message);
            return res.status(200).json({ success: true, message: 'Mensaje enviado.' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Error al enviar mensaje.' });
        }
    }

    return res.status(400).json({ error: 'Acción no válida o no proporcionada.' });
};
