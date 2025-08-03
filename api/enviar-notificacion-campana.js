// ====================================================================
// API: /api/enviar-notificacion-campana.js
// Propósito: Recibe órdenes de QStash y ejecuta el envío final.
// Seguridad: Protegido por firma de QStash.
// ====================================================================

import { verifySignature } from "@upstash/qstash/nextjs";
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sgMail = require('@sendgrid/mail');
const { getMessaging } = require('firebase-admin/messaging');

// --- Inicialización de servicios ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

try {
  const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  if (require('firebase-admin').apps.length === 0) {
    initializeApp({ credential: cert(serviceAccount) });
  }
} catch (e) {
  if (e.code !== 'app/duplicate-app') console.error('Firebase init error', e);
}

const db = getFirestore();
const messaging = getMessaging();

// --- Función Principal ---
async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { campaignId, tipoNotificacion, destinatarios } = req.body;
    if (!campaignId || !tipoNotificacion) {
      return res.status(400).json({ error: "Faltan campaignId o tipoNotificacion." });
    }
    
    await procesarNotificacionIndividual({ campaignId, tipoNotificacion, destinatarios });
    res.status(200).json({ message: 'Notificación procesada.' });

  } catch (error) {
    console.error(`Error ejecutando envío para campaña:`, error);
    res.status(500).json({ error: 'Fallo al procesar la notificación.', details: error.message });
  }
}

// Envolvemos el handler con el verificador de QStash
export default verifySignature(handler);


// --- Función de Ayuda ---
async function procesarNotificacionIndividual(trabajo) {
    const { campaignId, tipoNotificacion, destinatarios } = trabajo;

    const campanaDoc = await db.collection('campanas').doc(campaignId).get();
    if (!campanaDoc.exists) throw new Error(`Campaña con ID ${campaignId} no encontrada.`);
    const campanaData = campanaDoc.data();
    
    if (!campanaData.estaActiva) {
        console.log(`Campaña ${campaignId} está deshabilitada. Envío cancelado.`);
        return;
    }

    const templateId = tipoNotificacion === 'lanzamiento' ? 'nueva_campana' : 'recordatorio_campana';
    const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
    if (!templateDoc.exists) throw new Error(`Plantilla ${templateId} no encontrada.`);
    const plantilla = templateDoc.data();

    let clientesFinales = [];
    if (destinatarios && destinatarios.length > 0) {
        console.log(`Enviando a grupo de prueba: ${destinatarios.join(', ')}`);
        // Para hacer una búsqueda eficiente, necesitamos hacer varias consultas
        // y luego unirlas.
        const todosLosClientesSnapshot = await db.collection('clientes').where('numeroSocio', '!=', null).get();
        const todosLosClientes = todosLosClientesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        clientesFinales = todosLosClientes.filter(c => 
            destinatarios.includes(c.numeroSocio?.toString()) || destinatarios.includes(c.email)
        );
    } else {
        console.log("Enviando a todos los clientes suscritos.");
        const clientesSnapshot = await db.collection('clientes').where('numeroSocio', '!=', null).get();
        clientesFinales = clientesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    const clientesSuscritos = clientesFinales.filter(c => c.email || (c.fcmTokens && c.fcmTokens.length > 0));
    if (clientesSuscritos.length === 0) {
        console.log(`No se encontraron clientes suscritos para esta campaña.`);
        return;
    }

    const todosLosTokens = [...new Set(clientesSuscritos.flatMap(c => c.fcmTokens || []))];
    const todosLosEmails = [...new Set(clientesSuscritos.map(c => c.email).filter(Boolean))];

    // Envío Push masivo
    if (todosLosTokens.length > 0) {
        const title = plantilla.titulo.replace(/{nombre_campana}/g, campanaData.nombre);
        let body = plantilla.cuerpo
              .replace(/{nombre}/g, nombreCliente)
          .replace(/{nombre_campana}/g, campanaData.nombre)
            .replace(/{cuerpo_campana}/g, campanaData.cuerpo || '')
            .replace(/{fecha_inicio}/g, new Date(campanaData.fechaInicio).toLocaleDateString('es-ES'))
            .replace(/{fecha_fin}/g, new Date(campanaData.fechaFin).toLocaleDateString('es-ES'));
        
        const cleanBody = body.replace(/<[^>]*>?/gm, ' ').replace(/{nombre}/g, 'tú');
        
        await messaging.sendEachForMulticast({
            data: { title, body: cleanBody },
            tokens: todosLosTokens,
        });
        console.log(`Push enviado para campaña ${campaignId} a ${todosLosTokens.length} tokens.`);
    }

    // Envío de Emails
    for (const email of todosLosEmails) {
        const cliente = clientesSuscritos.find(c => c.email === email);
        const nombreCliente = cliente ? cliente.nombre.split(' ')[0] : 'Cliente';
        
        let subject = plantilla.titulo.replace(/{nombre_campana}/g, campanaData.nombre);
        let body = plantilla.cuerpo
            .replace(/{nombre}/g, nombreCliente)
            .replace(/{nombre_campana}/g, campanaData.nombre)
            .replace(/{cuerpo_campana}/g, campanaData.cuerpo || '')
            .replace(/{fecha_inicio}/g, new Date(campanaData.fechaInicio).toLocaleDateString('es-ES'))
            // Lógica condicional para la fecha de fin
let textoVigencia = '';
if (campanaData.fechaFin && campanaData.fechaFin !== '2100-01-01') {
    // Si hay una fecha de fin REAL, creamos el texto.
    textoVigencia = `Aprovecha los beneficios antes de que termine el ${new Date(campanaData.fechaFin).toLocaleDateString('es-ES')}. ¡Te esperamos!`;
} else {
    // Si no hay fecha de fin o es la fecha lejana, el texto es genérico.
    textoVigencia = '¡Aprovecha los beneficios! ¡Te esperamos!';
}
        body = body.replace(/\[TEXTO_VIGENCIA\]/g, textoVigencia);
      
        const htmlBody = `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
                <img src="https://raw.githubusercontent.com/pattala/rampet-cliente-app/main/images/mi_logo.png" alt="Logo RAMPET" style="width: 150px; display: block; margin: 0 auto 20px auto;">
                <h2 style="color: #0056b3;">${subject}</h2>
                <div>${body.replace(/\n/g, '<br>')}</div>
                <br>
                <p>Atentamente,<br><strong>El equipo de Club RAMPET</strong></p>
            </div>`;
        
        await sgMail.send({
            to: email,
            from: { email: process.env.SENDGRID_FROM_EMAIL, name: 'Club RAMPET' },
            subject: subject,
            html: htmlBody,
        });
    }
     console.log(`Emails enviados para campaña ${campaignId} a ${todosLosEmails.length} clientes.`);
}
