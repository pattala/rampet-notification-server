// api/send-whatsapp.js (VERSIÓN FINAL CON RUTA /tmp)

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

if (typeof global.waClient === 'undefined') {
    global.waClient = null;
    global.qrCodeData = null;
    global.clientStatus = 'UNINITIALIZED';
}

const initializeClient = () => {
    if (global.waClient || global.clientStatus === 'INITIALIZING') {
        return;
    }

    console.log('Inicializando cliente de WhatsApp en /tmp...');
    global.clientStatus = 'INITIALIZING';

    // --- INICIO DE LA CORRECCIÓN CLAVE ---
    // Le decimos a LocalAuth que guarde la sesión en la carpeta /tmp
    // que es la única carpeta escribible en Vercel.
    global.waClient = new Client({
        authStrategy: new LocalAuth({ dataPath: '/tmp' }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    });
    // --- FIN DE LA CORRECCIÓN CLAVE ---

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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Siempre intenta inicializar si no está listo
    if (global.clientStatus === 'UNINITIALIZED' && global.clientStatus !== 'INITIALIZING') {
        initializeClient();
    }

    const action = req.query.action || (req.body && req.body.action);
    
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
