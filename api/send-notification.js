// api/send-notification.js

const { google } = require("googleapis");

// Vercel envuelve esto en un servidor. 'req' es la petición, 'res' es la respuesta.
module.exports = async (req, res) => {
  // Configuración de CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { tokens, title, body } = req.body;

  if (!tokens || !title || !body || tokens.length === 0) {
    return res.status(400).json({ error: "Faltan datos: tokens, title o body." });
  }

  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

    const jwtClient = new google.auth.JWT(
        serviceAccount.client_email,
        null,
        serviceAccount.private_key,
        ["https://www.googleapis.com/auth/firebase.messaging"]
    );

    const accessToken = await jwtClient.getAccessToken();
    let successCount = 0;
    let failureCount = 0;

    const sendPromises = tokens.map(token => {
        
        // --- INICIO DE LA CORRECCIÓN ---
        // Se construye el mensaje usando la estructura 'webpush' para incluir el logo
        // y se elimina la clave 'notification' genérica para evitar duplicados.
        const message = {
            message: {
                token: token,
                webpush: {
                    notification: {
                        title: title,
                        body: body,
                        icon: 'https://i.postimg.cc/tJgqS2sW/mi-logo.png' // URL de tu logo
                    }
                }
            },
        };
        // --- FIN DE LA CORRECCIÓN ---
        
        return fetch(`https://fcm.googleapis.com/v1/projects/sistema-fidelizacion/messages:send`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${accessToken.token}`,
            },
            body: JSON.stringify(message),
        }).then(response => {
            if (response.ok) successCount++; else failureCount++;
        });
    });

    await Promise.all(sendPromises);
    
    return res.status(200).json({ success: true, successCount, failureCount });

  } catch (error) {
    console.error("Error en la función serverless:", error);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};
