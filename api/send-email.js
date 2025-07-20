// api/send-email.js (VERSIÓN FINAL Y RECOMENDADA CON LOGO)
// api/send-email.js (VERSIÓN FINAL CON COMENTARIOS)

// Importaciones de Firebase y SendGrid
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sgMail = require('@sendgrid/mail');

// Configuración de SendGrid con la API Key desde las variables de entorno
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Inicialización de Firebase (se ejecuta una sola vez)
// Inicialización de Firebase (se ejecuta una sola vez)
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

try { 
  initializeApp({ credential: cert(serviceAccount) }); 
} catch (e) { 
  // Evita el crash si la app ya está inicializada (común en entornos de desarrollo)
  if (e.code !== 'app/duplicate-app') console.error('Firebase init error', e); 
}

const db = getFirestore();
// Función de ayuda para reemplazar variables como {nombre} en las plantillas
function replacePlaceholders(template, data = {}) { 
  let result = template; 
  for (const key in data) { 
    result = result.replace(new RegExp(`{${key}}`, 'g'), data[key]); 
  } 
  return result; 
}
// Función principal de la API (Serverless Function)
export default async function handler(req, res) {
  
  // --- Cabeceras CORS ---
// Permiten que el panel de administrador (en localhost o Vercel) pueda llamar a esta API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Manejo de la petición de verificación "preflight" del navegador
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
// --- Lógica de la Petición POST ---
  if (req.method === 'POST') {
    try {
    
      // 1. Seguridad: Verifica que la petición venga de nuestro propio sistema
      if (req.headers.authorization !== `Bearer ${process.env.API_SECRET_KEY}`) {
        return res.status(401).json({ message: 'No autorizado' });
      }
// 2. Validación: Extrae los datos y se asegura de que existan
      const { to, templateId, templateData } = req.body;
      if (!to || !templateId) { 
        return res.status(400).json({ message: 'Faltan parámetros: to, templateId son requeridos.' }); 
      }
// 3. Lógica Principal: Obtiene la plantilla de Firestore
      const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
      if (!templateDoc.exists) { 
        return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` }); 
      }
// 4. Construcción del Email: Reemplaza variables y crea el HTML
      const plantilla = templateDoc.data();
      const subject = replacePlaceholders(plantilla.titulo, templateData);
      const body = replacePlaceholders(plantilla.cuerpo, templateData);

      // HTML CON EL FORMATO PROFESIONAL Y EL LOGO
      const htmlBody = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
            <img src="https://raw.githubusercontent.com/pattala/rampet-cliente-app/main/images/mi_logo.png" alt="Logo de RAMPET" style="width: 150px; display: block; margin: 0 auto 20px auto;">
            <h2 style="color: #0056b3;">${subject}</h2>
            <p>${body.replace(/\n/g, '<br>')}</p>
            <br>
            <p>Atentamente,<br><strong>El equipo de Club RAMPET</strong></p>
        </div>
      `;
// 5. Envío: Crea el objeto de mensaje y lo envía a través de SendGrid
      const msg = { 
        to: to, 
        from: { 
          email: process.env.SENDGRID_FROM_EMAIL, 
          name: 'Club RAMPET' 
        }, 
        subject: subject, 
        html: htmlBody 
      };
      
      await sgMail.send(msg);
     // 6. Respuesta Exitosa
      return res.status(200).json({ message: 'Email enviado con éxito a través de SendGrid.' });

    } catch (error) {
// Manejo de cualquier error que ocurra en el proceso
      console.error('Error al procesar el envío con SendGrid:', error);
      if (error.response) { console.error(error.response.body); }
      return res.status(500).json({ message: 'Error interno del servidor.', error: error.message });
    }
  } else {
// Si no es POST ni OPTIONS, se rechaza
    return res.status(405).json({ message: `Método ${req.method} no permitido.` });
  }
}
