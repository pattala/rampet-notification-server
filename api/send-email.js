// api/send-email.js (VERSIÓN FINAL CON FORMATO HTML CORREGIDO)

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

try { initializeApp({ credential: cert(serviceAccount) }); } catch (e) { if (e.code !== 'app/duplicate-app') console.error('Firebase init error', e); }
const db = getFirestore();
function replacePlaceholders(template, data = {}) { let result = template; for (const key in data) { result = result.replace(new RegExp(`{${key}}`, 'g'), data[key]); } return result; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { return res.status(200).end(); }

  if (req.method === 'POST') {
    try {
      if (req.headers.authorization !== `Bearer ${process.env.API_SECRET_KEY}`) {
        return res.status(401).json({ message: 'No autorizado' });
      }
      const { to, templateId, templateData } = req.body;
      if (!to || !templateId) { return res.status(400).json({ message: 'Faltan parámetros: to, templateId son requeridos.' }); }
      const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
      if (!templateDoc.exists) { return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` }); }
      const plantilla = templateDoc.data();
      const subject = replacePlaceholders(plantilla.titulo, templateData);
      const body = replacePlaceholders(plantilla.cuerpo, templateData);

      // ===== CAMBIO CLAVE AQUÍ: HTML MEJORADO CON LOGO =====
      const htmlBody = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
            <img src="https://raw.githubusercontent.com/pattala/rampet-cliente-app/main/images/mi_logo.png" alt="Logo de RAMPET" style="width: 150px; display: block; margin: 0 auto 20px auto;">
            <h2 style="color: #0056b3;">${subject}</h2>
            <p>${body.replace(/\n/g, '<br>')}</p>
            <br>
            <p>Atentamente,<br><strong>El equipo de Club RAMPET</strong></p>
        </div>
      `;
      // ====================================================

      const msg = { to: to, from: { email: process.env.SENDGRID_FROM_EMAIL, name: 'Club RAMPET' }, subject: subject, html: htmlBody };
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
}
```Después de hacer `deploy` con este cambio, todos los correos que envíe el sistema tendrán el logo y el formato correcto.

---

### 2. "no salio que salio el email , ni tampoco el push" (Fallo de Notificaciones)

Este es el problema más importante ahora. Si antes los push funcionaban y ahora no, y además no ves los mensajes de confirmación (los "toast"), significa que se ha introducido un nuevo error.

**Causa más probable:** Al arreglar los flujos de `registrarCompraFinal` y `aplicarBonoManual`, puede que algo en la llamada a la `enviarNotificacionTransaccional` esté fallando silenciosamente.

**Plan de Diagnóstico:**
Tenemos que volver a usar las herramientas de depuración, pero esta vez fijándonos en la notificación push.

**Acción Requerida:**

1.  **Revisa la pestaña "Network":**
    *   Haz de nuevo la prueba de registrar una compra.
    *   En la pestaña "Network" (F12), busca la petición que se llama `send-notification`.
    *   **¿Cuál es su `Status`?** ¿Es `200 OK` (verde) o es un error `500` (rojo)?

2.  **Revisa los Logs de Vercel:**
    *   Si en el paso anterior ves un error `500` para `send-notification`, ve a los logs de tu proyecto en Vercel.
    *   Provoca el error de nuevo y busca el mensaje de error en rojo asociado a `POST /api/send-notification`.

El resultado de estas dos comprobaciones nos dirá exactamente por qué las notificaciones push han dejado de funcionar. Es muy probable que sea un problema pequeño que se introdujo con los últimos cambios. Pásame el status que ves en la pestaña Network para `send-notification` y lo resolveremos.
