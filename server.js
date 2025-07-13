const express = require("express");
const { google } = require("googleapis");
const bodyParser = require("body-parser");
const cors = require('cors'); // Importamos cors
const app = express();

// Usamos cors para permitir peticiones desde cualquier origen
// Esto es necesario para que tu panel de admin local pueda comunicarse con el servidor
app.use(cors());

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

// Esta es la única "puerta" o "endpoint" que nuestro servidor tendrá abierta.
// Solo responde a peticiones POST a /send-notification
app.post("/send-notification", async (req, res) => {
    // Extraemos los datos que nos envía el panel de admin
    const { tokens, title, body } = req.body;

    // Verificación básica de que los datos llegaron
    if (!tokens || !title || !body || tokens.length === 0) {
        return res.status(400).json({ error: "Faltan datos: tokens, title o body." });
    }

    try {
        // Obtenemos un token de acceso de corta duración para autorizar la petición
        const accessToken = await jwtClient.getAccessToken();
        let successCount = 0;
        let failureCount = 0;

        // Creamos una promesa para cada notificación que queremos enviar
        const sendPromises = tokens.map(token => {
             const message = {
                message: {
                    token: token,
                    notification: { title, body },
                },
            };
            
            // Hacemos la llamada a la API de Firebase Cloud Messaging (FCM)
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

        // Esperamos a que todas las promesas de envío se completen
        await Promise.all(sendPromises);

        // Devolvemos una respuesta exitosa al panel de admin
        console.log(`Envío completado. Éxitos: ${successCount}, Fallos: ${failureCount}`);
        res.json({ success: true, successCount, failureCount });

    } catch (error) {
        console.error("Error al enviar notificación:", error);
        res.status(500).json({ error: "Error interno del servidor al procesar la solicitud." });
    }
});

// Definimos el puerto en el que correrá el servidor
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Servidor de notificaciones escuchando en el puerto ${port}`);
});
