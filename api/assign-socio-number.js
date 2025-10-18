// /api/assign-socio-number.js  (ESM + CORS + asigna N° socio + email bienvenida)
import admin from 'firebase-admin';

// Inicializa Firebase Admin una sola vez
if (!admin.apps.length) {
  const creds = process.env.GOOGLE_CREDENTIALS_JSON;
  if (creds) {
    const serviceAccount = JSON.parse(creds);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
    // fallback si usás ADC (no recomendado para Vercel)
    admin.initializeApp();
  }
}

const db = admin.firestore();

// ---- CORS (eco del origin si está permitido) ----
const ALLOWED = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

export default async function handler(req, res) {

  // ---- CORS: permitir orígenes del Panel y headers necesarios ----
  const allowedOrigins = [
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'https://TU-DOMINIO-DEL-PANEL',     // <-- si corresponde
    'https://TU-OTRO-DOMINIO-SI-CORRESPONDE',
    // PWA
    'https://rampet.vercel.app',
  ];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin'); // para caches
  res.setHeader('Access-Control-Allow-Credentials', 'true'); // si te hace falta cookies (opcional)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

  // Preflight (OPTIONS) debe responder sin más
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Extra: si configuraste CORS_ALLOWED_ORIGINS, respetalo también
  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  // Body-safe: si llega string (algunas configs de Vercel), parseamos
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  let { docId, sendWelcome } = body || {};
  if (!docId) {
    return res.status(400).json({ error: 'Falta el ID del documento del cliente.' });
  }

  // 🔹 REGLA NUEVA:
  // - Si el Panel envía explícitamente sendWelcome true/false → se respeta.
  // - Si NO lo envía, entonces:
  //     * Desde la PWA (rampet.vercel.app) => enviamos email (true).
  //     * Desde otros orígenes => no cambiar el comportamiento previo (false).
  const isPwaOrigin = origin === 'https://rampet.vercel.app';
  const shouldSendWelcome = (typeof sendWelcome === 'boolean') ? sendWelcome : isPwaOrigin;

  try {
    const contadorRef = db.collection('configuracion').doc('contadores');
    const clienteRef = db.collection('clientes').doc(docId);

    // Datos que vamos a usar para el email
    let datosClienteParaEmail = null;

    // --- Transacción: asignar número de socio correlativo ---
    await db.runTransaction(async (tx) => {
      const [contadorDoc, clienteDoc] = await Promise.all([
        tx.get(contadorRef),
        tx.get(clienteRef),
      ]);

      if (!clienteDoc.exists) {
        throw new Error('El documento del cliente no existe.');
      }

      const clienteData = clienteDoc.data();

      // Si ya tenía número, salimos (no reenviamos email)
      if (clienteData.numeroSocio) {
        console.log(`Cliente ${docId} ya tenía N° de Socio. Nada que hacer.`);
        return;
      }

      // Datos base para el email (completamos N° abajo)
      datosClienteParaEmail = {
        id_cliente: docId,
        nombre: clienteData.nombre,
        email: clienteData.email,
        puntos_ganados: clienteData.puntos || 0,
      };

      let nuevoNumeroSocio = 1;
      if (contadorDoc.exists && contadorDoc.data().ultimoNumeroSocio) {
        nuevoNumeroSocio = contadorDoc.data().ultimoNumeroSocio + 1;
      }

      // Actualizar contador y cliente
      tx.set(contadorRef, { ultimoNumeroSocio: nuevoNumeroSocio }, { merge: true });
      tx.update(clienteRef, { numeroSocio: nuevoNumeroSocio });

      // Guardar N° para el email
      datosClienteParaEmail.numero_socio = nuevoNumeroSocio;

      console.log(`Asignado N° de Socio ${nuevoNumeroSocio} al cliente ${docId}`);
    });

    // Si no hubo cambios (ya tenía N°), devolvemos OK
    if (!datosClienteParaEmail) {
      return res.status(200).json({ message: 'El cliente ya tenía número de socio. No se envió email.' });
    }

    // --- Enviar email de bienvenida según regla shouldSendWelcome ---
    if (shouldSendWelcome) {
      try {
        const baseUrl = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
        const r = await fetch(`${baseUrl}/api/send-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.API_SECRET_KEY}`
          },
          body: JSON.stringify({
            to: datosClienteParaEmail.email,
            templateId: 'bienvenida',
            templateData: {
              nombre: datosClienteParaEmail.nombre,
              numero_socio: datosClienteParaEmail.numero_socio,
              puntos_ganados: datosClienteParaEmail.puntos_ganados,
              id_cliente: datosClienteParaEmail.id_cliente,
            }
          })
        });

        const mailResp = await r.json().catch(() => ({}));
        return res.status(200).json({
          ok: true,
          message: 'Número de socio asignado y email de bienvenida enviado (o encolado).',
          numeroSocio: datosClienteParaEmail.numero_socio,
          emailEnviado: true,
          mail: mailResp
        });
      } catch (err) {
        console.error('Error enviando email de bienvenida:', err);
        return res.status(200).json({
          ok: true,
          message: 'Número de socio asignado. Falló el envío de email de bienvenida.',
          numeroSocio: datosClienteParaEmail.numero_socio,
          emailEnviado: false,
          mail: { error: 'send-email failed' }
        });
      }
    } else {
      console.log('[assign-socio-number] sendWelcome=false → no se envía email.');
      return res.status(200).json({
        ok: true,
        message: 'Número de socio asignado (sin email de bienvenida por configuración).',
        numeroSocio: datosClienteParaEmail.numero_socio,
        emailEnviado: false
      });
    }

  } catch (error) {
    console.error('Error asignando número de socio:', error);
    return res.status(500).json({ error: 'Error interno del servidor.', details: error.message });
  }
}
