// /api/assign-socio-number.js (VERSIÓN CON CORS + EMAIL DE BIENVENIDA)
const admin = require('firebase-admin');

// Inicializa la app de Firebase Admin si no lo ha hecho ya
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// ---- CORS ----
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173,https://pattala.github.io')
  .split(',')
  .map(s => s.trim());

function applyCORS(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.some(a => origin.startsWith(a))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true; // preflight end
  }
  return false;
}

export default async function handler(req, res) {
  if (applyCORS(req, res)) return; // maneja preflight OPTIONS

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const { docId } = req.body || {};
  if (!docId) {
    return res.status(400).json({ error: 'Falta el ID del documento del cliente.' });
  }

  try {
    const contadorRef = db.collection('configuracion').doc('contadores');
    const clienteRef = db.collection('clientes').doc(docId);

    // Guardamos datos para email fuera de la transacción
    let datosClienteParaEmail = null;

    await db.runTransaction(async (transaction) => {
      const contadorDoc = await transaction.get(contadorRef);
      const clienteDoc = await transaction.get(clienteRef);

      if (!clienteDoc.exists) {
        throw new Error('El documento del cliente no existe.');
      }

      const clienteData = clienteDoc.data();

      // Si ya tiene número, no reasignamos (y tampoco mandamos email)
      if (clienteData.numeroSocio) {
        console.log(`El cliente ${docId} ya tenía N° de Socio. No se hace nada.`);
        return;
      }

      // Tomamos datos básicos para el email (los completamos con el nro más abajo)
      datosClienteParaEmail = {
        nombre: clienteData.nombre,
        email: clienteData.email,
        puntos: clienteData.puntos || 0,
        id_cliente: docId
      };

      // Calcular nuevo número correlativo
      let nuevoNumeroSocio = 1;
      if (contadorDoc.exists && contadorDoc.data().ultimoNumeroSocio) {
        nuevoNumeroSocio = contadorDoc.data().ultimoNumeroSocio + 1;
      }

      // Actualizar contador y asignar al cliente
      transaction.set(contadorRef, { ultimoNumeroSocio: nuevoNumeroSocio }, { merge: true });
      transaction.update(clienteRef, { numeroSocio: nuevoNumeroSocio });

      // Completar datos para email
      datosClienteParaEmail.numero_socio = nuevoNumeroSocio;

      console.log(`Asignado N° de Socio ${nuevoNumeroSocio} al cliente con docId: ${docId}`);
    });

    // Si no hay datos (p.ej. ya tenía número), devolvemos OK sin enviar email
    if (!datosClienteParaEmail) {
      return res.status(200).json({ message: 'El cliente ya tenía número de socio. No se envió email.' });
    }

    // ---- Envío de email de bienvenida (server-side) ----
    try {
      const baseUrl = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
      const r = await fetch(`${baseUrl}/api/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Validación con secreto del lado del servidor
          'Authorization': `Bearer ${process.env.MI_API_SECRET}`
        },
        body: JSON.stringify({
          to: datosClienteParaEmail.email,
          templateId: 'bienvenida', // cambiá si usás otro ID
          templateData: {
            nombre: datosClienteParaEmail.nombre,
            numero_socio: datosClienteParaEmail.numero_socio,
            puntos_ganados: datosClienteParaEmail.puntos || 0,
            id_cliente: datosClienteParaEmail.id_cliente
          }
        })
      });

      const mailResp = await r.json().catch(() => ({}));
      // No cortamos el flujo si hubo problema con el email
      return res.status(200).json({
        message: 'Número de socio asignado y email de bienvenida enviado (o encolado).',
        numeroSocio: datosClienteParaEmail.numero_socio,
        mail: mailResp
      });
    } catch (err) {
      console.error('Error al enviar email de bienvenida:', err);
      // Continuamos, pero avisamos en la respuesta
      return res.status(200).json({
        message: 'Número de socio asignado. Falló el envío de email de bienvenida.',
        numeroSocio: datosClienteParaEmail.numero_socio,
        mail: { error: 'send-email failed' }
      });
    }

  } catch (error) {
    console.error('Error asignando número de socio:', error);
    return res.status(500).json({ error: 'Error interno del servidor.', details: error.message });
  }
}
