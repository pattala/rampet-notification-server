const { google } = require("googleapis");

// Esta función es ahora el "servidor". Vercel se encarga del resto.
module.exports = async (req, res) => {
  // Configuración de CORS manual para asegurar que funcione
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // O un origen específico
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Si es una petición OPTIONS (preflight), terminamos aquí
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
        const message = {
            message: {
                token: token,
                notification: { title, body },
            },
        };
        
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
    console.error("Error al enviar notificación:", error);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};
