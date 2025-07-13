// api/send-whatsapp.js (VERSIÓN FINAL OPTIMIZADA PARA VERCEL)

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

// Almacenamiento global para persistir la conexión
if (typeof global.sock === 'undefined') {
    global.sock = null;
    global.qrCodeData = null;
    global.connectionStatus = 'UNINITIALIZED';
}

async function connectToWhatsApp() {
    if (global.sock || global.connectionStatus === 'CONNECTING') {
        console.log('Conexión ya en progreso. Estado actual:', global.connectionStatus);
        return;
    }
    
    console.log('Iniciando nueva conexión con Baileys...');
    global.connectionStatus = 'CONNECTING';

    try {
        const { state, saveCreds } = await useMultiFileAuthState('/tmp/baileys_auth_info');
        
        // --- INICIO DE LA CORRECCIÓN CLAVE ---
        // Se añade un logger de Pino optimizado, que es más rápido.
        // Se usa un identificador de navegador estándar.
        global.sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['Baileys', 'Desktop', '4.0.0'],
            logger: pino({ level: 'silent' }), // Logger silencioso para producción
        });
        // --- FIN DE LA CORRECCIÓN CLAVE ---

        global.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                console.log('QR generado. Esperando escaneo.');
                global.qrCodeData = qr;
                global.connectionStatus = 'QR_READY';
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Conexión cerrada, motivo:', lastDisconnect.error, ', reconectando:', shouldReconnect);
                global.connectionStatus = 'DISCONNECTED';
                if (global.sock) {
                    global.sock.ws.close();
                    global.sock = null;
                }
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 5000); // Reintenta conectar después de 5s
                }
            } else if (connection === 'open') {
                console.log('¡Conexión de WhatsApp establecida!');
                global.connectionStatus = 'READY';
                global.qrCodeData = null;
            }
        });

        global.sock.ev.on('creds.update', saveCreds);
        
    } catch (error) {
        console.error('Error fatal al inicializar Baileys:', error);
        global.connectionStatus = 'ERROR';
        global.sock = null;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (global.connectionStatus === 'UNINITIALIZED') {
        connectToWhatsApp();
    }

    const action = req.query.action || (req.body && req.body.action);

    if (action === 'status') {
        return res.status(200).json({ status: global.connectionStatus, qr: global.qrCodeData });
    }

    if (action === 'send') {
        if (global.connectionStatus !== 'READY') {
            return res.status(400).json({ success: false, error: 'Cliente de WhatsApp no está listo.' });
        }
        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ success: false, error: 'Faltan número o mensaje.' });
        }
        try {
            const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
            await global.sock.sendMessage(jid, { text: message });
            return res.status(200).json({ success: true, message: 'Mensaje enviado.' });
        } catch (error) {
            console.error('Error al enviar mensaje con Baileys:', error);
            return res.status(500).json({ success: false, error: 'Error al enviar mensaje.' });
        }
    }

    return res.status(400).json({ error: 'Acción no válida o no proporcionada.' });
}
