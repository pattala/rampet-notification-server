// api/send-whatsapp.js (VERSIÓN FINAL TOLERANTE A TIMEOUTS)

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

// Almacenamiento global para persistir el estado entre ejecuciones
if (typeof global.sock === 'undefined') {
    global.sock = null;
    global.qrCodeData = null;
    global.connectionStatus = 'UNINITIALIZED';
}

async function connectToWhatsApp() {
    // Si ya está conectado o conectando, no hacer nada
    if (global.sock || global.connectionStatus === 'CONNECTING') {
        return;
    }
    
    console.log('Iniciando conexión con Baileys...');
    global.connectionStatus = 'CONNECTING';

    try {
        const { state, saveCreds } = await useMultiFileAuthState('/tmp/baileys_auth_info');
        
        global.sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['RAMPET-Server', 'Chrome', '1.0.0'],
            logger: pino({ level: 'silent' }),
        });

        // Manejador de eventos clave
        global.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                console.log('QR generado.');
                global.qrCodeData = qr;
                global.connectionStatus = 'QR_READY';
            }
            if (connection === 'close') {
                const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Conexión cerrada, motivo: ${statusCode}, reconectando: ${shouldReconnect}`);
                global.connectionStatus = 'DISCONNECTED';
                global.sock = null;
                global.qrCodeData = null;
            } else if (connection === 'open') {
                console.log('Conexión de WhatsApp establecida.');
                global.connectionStatus = 'READY';
                global.qrCodeData = null;
            }
        });

        global.sock.ev.on('creds.update', saveCreds);
        
    } catch (error) {
        console.error('Error en connectToWhatsApp:', error);
        global.connectionStatus = 'ERROR';
        global.sock = null;
    }
}

// Handler principal de la función
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Intenta iniciar la conexión si nunca se ha hecho
    if (global.connectionStatus === 'UNINITIALIZED' || (global.connectionStatus === 'DISCONNECTED' && !global.sock)) {
        connectToWhatsApp();
    }

    const action = req.query.action || (req.body && req.body.action);

    if (action === 'status') {
        // Devuelve el estado actual inmediatamente, sea cual sea.
        return res.status(200).json({ status: global.connectionStatus, qr: global.qrCodeData });
    }

    if (action === 'send') {
        // Lógica de envío (sin cambios)
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
