const express = require("express");
const { google } = require("googleapis");
const bodyParser = require("body-parser");
const cors = require('cors');
const app = express();

// --- CONFIGURACIÓN DE CORS DEFINITIVA ---
// 1. Habilitamos CORS para todas las rutas
app.use(cors());

// 2. Respondemos explícitamente a las peticiones OPTIONS preflight
// Esto es lo que los navegadores envían para verificar los permisos ANTES de la petición POST
app.options('/send-notification', cors());
// -----------------------------------------

// Usamos bodyParser para poder leer el cuerpo de las peticiones POST
app.use(bodyParser.json());

// La clave secreta NO se sube a GitHub. La leemos desde las variables de entorno de Render.
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

// Configuramos el cliente JWT para autenticarnos con Google
const jwtClient = new google.auth.JWT(
    serviceAccount.client_email,
    null,
    serviceAccount.private_key,
    ["https://www.googleapis.com/auth/firebase.messaging"]
);

app.post("/send-notification", async (req, res) => {
    const { tokens, title, body } = req.body;

    if (!tokens || !title || !body || tokens.length === 0) {
        return res.status(400).json({ error: "Faltan datos: tokens, title o body." });
    }

    try {
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
                if (response.ok) {
                    successCount++;
                } else {
                    failureCount++;
                }
            }).catch(err => {
                console.error("Error en un fetch individual:", err);
                failureCount++;
            });
        });

        await Promise.all(sendPromises);
        console.log(`Envío completado. Éxitos: ${successCount}, Fallos: ${failureCount}`);
        res.json({ success: true, successCount, failureCount });

    } catch (error) {
        console.error("Error al enviar notificación:", error);
        res.status(500).json({ error: "Error interno del servidor al procesar la solicitud." });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Servidor de notificaciones escuchando en el puerto ${port}`);
});
