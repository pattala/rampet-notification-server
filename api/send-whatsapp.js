// api/send-whatsapp.js (VERSIÓN FINAL CON CHROMIUM PARA VERCEL)

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { Client, LocalAuth } = require('whatsapp-web.js-plus');

// Almacenamiento global para persistir el cliente
if (typeof global.waClient === 'undefined') {
    global.waClient = null;
    global.qrCodeData = null;
    global.clientStatus = 'UNINITIALIZED';
}

const initializeClient = async () => {
    if (global.waClient || global.clientStatus === 'INITIALIZING') {
        return;
    }

    console.log('Inicializando cliente de WhatsApp con Chromium para Vercel...');
    global.clientStatus = 'INITIALIZING';

    try {
        const browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        global.waClient = new Client({
            authStrategy: new LocalAuth({ dataPath: '/tmp' }),
            puppeteer: {
                browserWSEndpoint: browser.wsEndpoint()
            }
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

        await global.waClient.initialize();

    } catch (err) {
        console.error("Error catastrófico durante la inicialización:", err);
        global.waClient = null;
        global.clientStatus = 'ERROR';
    }
};

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

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
