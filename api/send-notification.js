// api/send-notification.js

const { google } = require("googleapis");

module.exports = async (req, res) => {
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
        // Ahora enviamos un payload de 'data'. El cliente se encargará de construir la notificación.
        // Esto nos da control total y evita problemas de visualización del navegador.
        const message = {
            message: {
                token: token,
                data: {
                    title: title,
                    body: body,
                    icon: 'https://github.com/pattala/rampet-cliente-app/blob/main/images/mi_logo.png' // URL del logo
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
