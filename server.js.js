const express = require("express");
const { google } = require("googleapis");
const bodyParser = require("body-parser");
const app = express();

app.use(bodyParser.json());
// Necesitamos CORS para permitir peticiones desde tu panel de admin local
const cors = require('cors');
app.use(cors());


// La clave secreta NO se sube a GitHub. La pondremos como una variable de entorno en Render.
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

const jwtClient = new google.auth.JWT(
    serviceAccount.client_email,
    null,
    serviceAccount.private_key,
    ["https://www.googleapis.com/auth/firebase.messaging"]
);

app.post("/send-notification", async (req, res) => {
    const { tokens, title, body } = req.body;

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
                    Authorization: `Bearer ${accessToken.token}`,
                },
                body: JSON.stringify(message),
            }).then(response => {
                if (response.ok) successCount++;
                else failureCount++;
            });
        });

        await Promise.all(sendPromises);
        res.json({ success: true, successCount, failureCount });

    } catch (error) {
        console.error("Error al enviar notificación:", error);
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Servidor escuchando en el puerto ${port}`);
});