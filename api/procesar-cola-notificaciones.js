// Archivo: [TU_PROYECTO_VERCEL]/api/procesar-cola-notificaciones.js

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
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

// --- Función Principal (Handler de Vercel) ---
export default async function handler(req, res) {
  // 1. Seguridad: Solo permitir ejecución desde Cron Jobs de Vercel
  if (req.headers['x-vercel-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  console.log('Iniciando proceso de la cola de notificaciones...');
  const ahora = Timestamp.now();
  let trabajosProcesados = 0;

  try {
    // 2. Buscar trabajos pendientes cuya fecha de envío ya pasó
    const trabajosPendientesQuery = db.collection('cola_de_notificaciones')
      .where('estado', '==', 'pendiente')
      .where('fechaEnvioProgramado', '<=', ahora);
      
    const snapshot = await trabajosPendientesQuery.get();

    if (snapshot.empty) {
      console.log('No hay trabajos pendientes para procesar.');
      return res.status(200).json({ message: 'No hay trabajos pendientes.' });
    }

    // 3. Procesar cada trabajo encontrado
    for (const doc of snapshot.docs) {
      const trabajo = doc.data();
      const trabajoRef = doc.ref;

      // Marcar como 'en_proceso' para evitar duplicados
      await trabajoRef.update({ estado: 'en_proceso' });
      
      try {
        await procesarNotificacionIndividual(trabajo);
        // Si todo va bien, marcar como 'completado'
        await trabajoRef.update({ estado: 'completado', fechaProcesado: Timestamp.now() });
        trabajosProcesados++;
      } catch (error) {
        console.error(`Error procesando trabajo ${doc.id}:`, error.message);
        await trabajoRef.update({ estado: 'error', mensajeError: error.message });
      }
    }

    console.log(`Proceso finalizado. Trabajos procesados: ${trabajosProcesados}`);
    res.status(200).json({ message: `Proceso completado. ${trabajosProcesados} trabajos procesados.` });

  } catch (error) {
    console.error('Error general en el Cron Job:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
}


// --- Función de Ayuda para procesar un único trabajo ---
async function procesarNotificacionIndividual(trabajo) {
    const { campaignId, tipoNotificacion } = trabajo;

    // 1. Obtener datos de la campaña
    const campanaDoc = await db.collection('campanas').doc(campaignId).get();
    if (!campanaDoc.exists) throw new Error(`Campaña con ID ${campaignId} no encontrada.`);
    const campanaData = campanaDoc.data();

    // 2. Obtener la plantilla de mensaje
    const templateId = tipoNotificacion === 'lanzamiento' ? 'nueva_campana' : 'recordatorio_campana'; // Asumimos que existirá 'recordatorio_campana'
    const templateDoc = await db.collection('plantillas_mensajes').doc(templateId).get();
    if (!templateDoc.exists) throw new Error(`Plantilla ${templateId} no encontrada.`);
    const plantilla = templateDoc.data();

    // 3. Obtener todos los clientes suscritos
    const clientesSnapshot = await db.collection('clientes')
      .where('numeroSocio', '!=', null) // Clientes aprobados
      .get();
      
    const clientesSuscritos = clientesSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(c => c.email || (c.fcmTokens && c.fcmTokens.length > 0));

    if (clientesSuscritos.length === 0) {
        console.log(`No hay clientes suscritos para la campaña ${campaignId}. Trabajo completado.`);
        return;
    }

    // 4. Preparar y enviar notificaciones (reutilizando la lógica que ya tenías)
    const todosLosTokens = [...new Set(clientesSuscritos.flatMap(c => c.fcmTokens || []))];
    const todosLosEmails = [...new Set(clientesSuscritos.map(c => c.email).filter(Boolean))];

    // Envío Push masivo
    if (todosLosTokens.length > 0) {
        const title = plantilla.titulo.replace('{nombre_campana}', campanaData.nombre);
        let body = plantilla.cuerpo.replace(/{nombre_campana}/g, campanaData.nombre)
                            .replace(/{cuerpo_campana}/g, campanaData.cuerpo || '')
                            .replace(/{fecha_fin}/g, new Date(campanaData.fechaFin).toLocaleDateString('es-ES'));
        
        const cleanBody = body.replace(/<[^>]*>?/gm, ' ').replace('{nombre}', 'tú'); // Limpiar HTML y placeholder de nombre
        
        await messaging.sendEachForMulticast({
            data: { title, body: cleanBody },
            tokens: todosLosTokens,
        });
        console.log(`Push enviado para campaña ${campaignId} a ${todosLosTokens.length} tokens.`);
    }

    // Envío de Emails (uno por uno para personalización)
    for (const email of todosLosEmails) {
        const cliente = clientesSuscritos.find(c => c.email === email);
        const nombreCliente = cliente ? cliente.nombre.split(' ')[0] : 'Cliente';
        
        let subject = plantilla.titulo.replace('{nombre_campana}', campanaData.nombre);
        let body = plantilla.cuerpo.replace(/{nombre}/g, nombreCliente)
                            .replace(/{nombre_campana}/g, campanaData.nombre)
                            .replace(/{cuerpo_campana}/g, campanaData.cuerpo || '')
                            .replace(/{fecha_fin}/g, new Date(campanaData.fechaFin).toLocaleDateString('es-ES'));
        
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
