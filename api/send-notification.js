const { google } = require("googleapis");

// Vercel envuelve esto en un servidor. 'req' es la petición, 'res' es la respuesta.
module.exports = async (req, res) => {
  // Configuración de CORS para permitir que tu panel se comunique con esta función.
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // Permite cualquier origen
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // El navegador envía una petición OPTIONS ("preflight") para verificar permisos.
  // Respondemos que sí y terminamos la ejecución.
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Extraemos los datos que envía tu panel de administrador
  const { tokens, title, body } = req.body;

  if (!tokens || !title || !body || tokens.length === 0) {
    return res.status(400).json({ error: "Faltan datos: tokens, title o body." });
  }

  try {
    // Usamos la clave secreta guardada en las variables de entorno de Vercel
    const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

    // Creamos un cliente de autenticación
    const jwtClient = new google.auth.JWT(
        serviceAccount.client_email,
        null,
        serviceAccount.private_key,
        ["https://www.googleapis.com/auth/firebase.messaging"]
    );

    // Obtenemos el token de acceso para autorizar la petición a Firebase
    const accessToken = await jwtClient.getAccessToken();
    let successCount = 0;
    let failureCount = 0;

    // Preparamos y enviamos una notificación por cada token de dispositivo
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

    // Esperamos a que todos los envíos terminen
    await Promise.all(sendPromises);
    
    // Enviamos una respuesta de éxito a tu panel
    return res.status(200).json({ success: true, successCount, failureCount });

  } catch (error) {
    console.error("Error en la función serverless:", error);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};
