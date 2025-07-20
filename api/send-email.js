// api/send-email.js (VERSIÓN FINAL Y RECOMENDADA CON LOGO)

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

try { 
  initializeApp({ credential: cert(serviceAccount) }); 
} catch (e) { 
  if (e.code !== 'app/duplicate-app') console.error('Firebase init error', e); 
}

const db = getFirestore();

function replacePlaceholders(template, data = {}) { 
  let result = template; 
  for (const key in data) { 
    result = result.replace(new RegExp(`{${key}}`, 'g'), data[key]); 
  } 
  return result; 
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    try {
      if (req.headers.authorization !== `Bearer ${process.env.API_SECRET_KEY}`) {
        return res.status(401).json({ message: 'No autorizado' });
      }

      const { to, templateId, templateData } = req.body;
      if (!to || !templateId) { 
        return res.status(400).json({ message: 'Faltan parámetros: to, templateId son requeridos.' }); 
      }

      const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
      if (!templateDoc.exists) { 
        return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` }); 
      }

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
      return res.status(200).json({ message: 'Email enviado con éxito a través de SendGrid.' });

    } catch (error) {
      console.error('Error al procesar el envío con SendGrid:', error);
      if (error.response) { console.error(error.response.body); }
      return res.status(500).json({ message: 'Error interno del servidor.', error: error.message });
    }
  } else {
    return res.status(405).json({ message: `Método ${req.method} no permitido.` });
  }
}```

### Pasos Finales:

1.  Asegúrate de que este código esté en tu archivo `api/send-email.js`.
2.  Guarda y sube los cambios a Vercel para que se genere el último **deploy**.
3.  Una vez terminado el despliegue, haz la prueba final desde **Live Server**.

Ahora sí, con la clave API nueva y este código, todo el sistema de correos debería funcionar perfectamente, incluyendo el formato con el logo. ¡Estoy seguro de que esta vez funcionará
