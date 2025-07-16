// api/send-notification.js (VERSIÓN FINAL SEGURA CON API KEY)
const { google } = require("googleapis");

module.exports = async (req, res) => {
    // ----- INICIO DEL BLOQUE DE SEGURIDAD -----
    const secretKey = process.env.API_SECRET_KEY;
    const providedKey = req.headers.authorization;

    if (!secretKey) {
        console.error("API_SECRET_KEY no está configurada en Vercel.");
        return res.status(500).json({ message: 'Error de configuración del servidor.' });
    }
    if (!providedKey || providedKey !== `Bearer ${secretKey}`) {
        // Petición no autorizada.
        return res.status(401).json({ message: 'Acceso no autorizado.' });
    }
    // ----- FIN DEL BLOQUE DE SEGURIDAD -----

    // Manejo de CORS, incluyendo la cabecera 'Authorization'.
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Solo se permiten peticiones POST' });
    }

    const { tokens, title, body } = req.body;

    if (!tokens || !title || !body || !Array.isArray(tokens) || tokens.length === 0) {
        return res.status(400).json({ error: "Faltan datos o son incorrectos: tokens (array no vacío), title o body." });
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
                    data: {
                        title: title,
                        body: body,
                        icon: 'https://raw.githubusercontent.com/pattala/rampet-cliente-app/main/images/mi_logo.png'
                    }
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
                if (response.ok) {
                    successCount++;
                } else {
                    failureCount++;
                    response.json().then(errorBody => console.warn(`Fallo en token ${token}:`, errorBody));
                }
            }).catch(err => {
                failureCount++;
                console.error(`Error de red en token ${token}:`, err);
            });
        });

        await Promise.all(sendPromises);
        
        return res.status(200).json({ success: true, successCount, failureCount });

    } catch (error) {
        console.error("Error en la función serverless:", error);
        return res.status(500).json({ error: "Error interno del servidor." });
    }
};
