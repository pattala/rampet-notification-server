import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys';
import { Boom } from '@hapi/boom';

// Estado global
let sock;
let qrCodeData;
let connectionStatus = 'UNINITIALIZED';

async function connectToWhatsApp() {
    if (sock || connectionStatus === 'CONNECTING') {
        return;
    }
    
    console.log('Iniciando conexión con Baileys...');
    connectionStatus = 'CONNECTING';

    try {
        const { state, saveCreds } = await useMultiFileAuthState('/tmp/baileys_auth_info');
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['RAMPET', 'Chrome', '1.0.0'], // Usar un User Agent simple
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                console.log('QR generado. Escanee para conectar.');
                qrCodeData = qr;
                connectionStatus = 'QR_READY';
            }
            if (connection === 'close') {
                const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
                console.log(`Conexión cerrada, motivo: ${statusCode}`);
                connectionStatus = 'DISCONNECTED';
                sock = null;
                qrCodeData = null;
                // No reintentar automáticamente para evitar bucles en Vercel
            } else if (connection === 'open') {
                console.log('¡Conexión de WhatsApp establecida!');
                connectionStatus = 'READY';
                qrCodeData = null;
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
    } catch (error) {
        console.error('Error durante la inicialización de Baileys:', error);
        connectionStatus = 'ERROR';
        sock = null;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Si la conexión se perdió o nunca se inició, intenta conectar
    if (!sock && connectionStatus !== 'CONNECTING') {
        connectToWhatsApp();
    }

    const action = req.query.action || (req.body && req.body.action);

    if (action === 'status') {
        return res.status(200).json({ status: connectionStatus, qr: qrCodeData });
    }

    if (action === 'send') {
        if (connectionStatus !== 'READY') {
            return res.status(400).json({ success: false, error: 'WhatsApp no está listo.' });
        }
        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ success: false, error: 'Faltan número o mensaje.' });
        }
        try {
            const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
            await sock.sendMessage(jid, { text: message });
            return res.status(200).json({ success: true, message: 'Mensaje enviado.' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Error al enviar mensaje.' });
        }
    }

    return res.status(400).json({ error: 'Acción no válida.' });
}
