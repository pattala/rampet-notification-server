// /api/send-notification.js (ESM + CORS + auth flexible + FCM + limpia tokens inválidos)
import admin from 'firebase-admin';

if (!admin.apps.length) {
  const creds = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : null;
  if (creds) admin.initializeApp({ credential: admin.credential.cert(creds) });
  else admin.initializeApp();
}
const db = admin.firestore();
const messaging = admin.messaging();

// ---- CORS (igual que send-email)
const ALLOWED = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

function isAuthorized(req) {
  const origin = req.headers.origin || '';
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  // Server→server
  if (token && (token === process.env.API_SECRET_KEY || token === process.env.MI_API_SECRET)) return true;

  // Fallback: permitir panel por Origin
  if (ALLOWED.includes(origin)) return true;

  return false;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: `Método ${req.method} no permitido.` });
  if (!isAuthorized(req)) return res.status(401).json({ message: 'No autorizado.' });

  try {
    const { title, body, data, tokens, clienteId } = req.body || {};

    // Resolver tokens
    let tokenList = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
    if (!tokenList.length && clienteId) {
      const snap = await db.collection('clientes').doc(clienteId).get();
      if (!snap.exists) return res.status(404).json({ message: 'Cliente no encontrado.' });
      tokenList = (snap.data().fcmTokens || []).filter(Boolean);
    }
    if (!tokenList.length) return res.status(400).json({ message: 'No hay tokens para enviar.' });

    // Mensaje
    const msg = {
      notification: { title: title || 'Club RAMPET', body: body || 'Tienes novedades' },
      data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [String(k), String(v ?? '')])),
      tokens: tokenList,
      webpush: { fcmOptions: { link: process.env.PWA_URL || 'https://rampet.vercel.app' } },
    };

    // Enviar
    const resp = await messaging.sendEachForMulticast(msg);

    // Limpiar tokens inválidos
    const invalid = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
          invalid.push(tokenList[i]);
        }
      }
    });
    if (clienteId && invalid.length) {
      await db.collection('clientes').doc(clienteId).update({
        fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalid),
      });
    }

    return res.status(200).json({
      ok: true,
      successCount: resp.successCount,
      failureCount: resp.failureCount,
      invalidTokens: invalid.length,
    });
  } catch (err) {
    console.error('Error enviando push:', err);
    return res.status(500).json({ message: 'Error interno del servidor.', error: err.message });
  }
}
