// /api/assign-socio-number.js  (ESM + CORS + asigna N° socio + email bienvenida opcional)
import admin from 'firebase-admin';

// Inicializa Firebase Admin una sola vez
if (!admin.apps.length) {
  const creds = process.env.GOOGLE_CREDENTIALS_JSON;
  if (creds) {
    const serviceAccount = JSON.parse(creds);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
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
  // ✅ agrega x-api-key para que el preflight no falle
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const clientKey = req.headers['x-api-key'];
  if (!clientKey || clientKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { docId, sendWelcome } = (req.body || {});
  if (!docId) {
    return res.status(400).json({ error: 'Falta el ID del documento del cliente.' });
  }

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
    });

    // Si no hubo cambios (ya tenía N°), devolvemos OK
    if (!datosClienteParaEmail) {
      return res.status(200).json({ message: 'El cliente ya tenía número de socio. No se envió email.' });
    }

    // --- Enviar email de bienvenida SOLO si el Panel lo pidió ---
    let mail = { attempted: false, ok: false };
    if (sendWelcome === true) {
      mail.attempted = true;
      try {
        const baseUrl =
          process.env.PUBLIC_BASE_URL ||
          `${(req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0]}://${req.headers.host}`;

        const r = await fetch(`${baseUrl}/api/send-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Soportá ambos encabezados, por compatibilidad:
            'x-api-key': process.env.API_SECRET_KEY || '',
            'Authorization': `Bearer ${process.env.API_SECRET_KEY || ''}`
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
        mail.ok = r.ok;
        mail.response = mailResp;
      } catch (err) {
        console.error('Error enviando email de bienvenida:', err);
        mail.error = String(err?.message || err);
      }
    }

    return res.status(200).json({
      message: 'Número de socio asignado.',
      numeroSocio: datosClienteParaEmail.numero_socio,
      mail
    });

  } catch (error) {
    console.error('Error asignando número de socio:', error);
    return res.status(500).json({ error: 'Error interno del servidor.', details: error.message });
  }
}
