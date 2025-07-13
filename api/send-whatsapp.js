// api/send-whatsapp.js (VERSIÓN ROBUSTA Y REESTRUCTURADA)

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// --- INICIO DEL CAMBIO CLAVE ---
// Se declara el cliente de WhatsApp FUERA del handler.
// Esto permite que persista entre invocaciones de la función en Vercel.
let client;
let qrCodeData;
let clientStatus = 'UNINITIALIZED';

// Función para inicializar el cliente
const initializeClient = () => {
  if (client) return; // Si ya existe, no hacer nada

  console.log('Inicializando cliente de WhatsApp...');
  clientStatus = 'INITIALIZING';

  client = new Client({
    authStrategy: new LocalAuth(), // Usa autenticación local para recordar la sesión
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'], // Necesario para correr en Vercel
    },
  });

  client.on('qr', (qr) => {
    console.log('QR Recibido. El cliente necesita escanear.');
    qrCodeData = qr;
    clientStatus = 'QR_READY';
  });

  client.on('ready', () => {
    console.log('¡Cliente de WhatsApp está listo!');
    qrCodeData = null; // Limpiamos el QR porque ya no es necesario
    clientStatus = 'READY';
  });

  client.on('auth_failure', (msg) => {
    console.error('Fallo de autenticación:', msg);
    clientStatus = 'AUTH_FAILURE';
    client = null; // Reseteamos para reintentar
  });

  client.on('disconnected', (reason) => {
    console.log('Cliente desconectado:', reason);
    clientStatus = 'DISCONNECTED';
    client = null; // Reseteamos para reintentar
  });

  client.initialize().catch(err => {
      console.error("Error durante la inicialización del cliente:", err);
      clientStatus = 'ERROR';
      client = null;
  });
};

// Se llama a la función de inicialización una vez cuando el servidor arranca.
initializeClient();
// --- FIN DEL CAMBIO CLAVE ---


// El handler principal ahora solo consulta el estado o envía mensajes.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action, number, message } = req.body;
  const queryAction = req.query.action;
  
  const finalAction = action || queryAction;

  if (finalAction === 'status') {
    // Devuelve el estado actual y el QR si existe
    return res.status(200).json({ status: clientStatus, qr: qrCodeData });

  } else if (finalAction === 'send') {
    if (clientStatus !== 'READY') {
      return res.status(400).json({ success: false, error: 'El cliente de WhatsApp no está listo.' });
    }
    if (!number || !message) {
      return res.status(400).json({ success: false, error: 'Faltan el número o el mensaje.' });
    }

    // Formatear el número para que termine en @c.us
    const chatId = `${number.replace('+', '')}@c.us`;

    try {
      await client.sendMessage(chatId, message);
      return res.status(200).json({ success: true, message: 'Mensaje enviado.' });
    } catch (error) {
      console.error("Error al enviar mensaje:", error);
      return res.status(500).json({ success: false, error: 'Error al enviar el mensaje.' });
    }
    
  } else {
    return res.status(400).json({ error: 'Acción no válida.' });
  }
};
