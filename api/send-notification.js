// /api/send-notification.js (ESM + CORS + auth flexible + FCM + plantillas + icon)
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

// ---- CORS
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

  // server→server
  if (token && (token === process.env.API_SECRET_KEY || token === process.env.MI_API_SECRET)) return true;
  // panel por CORS
  if (ALLOWED.includes(origin)) return true;

  return false;
}

// ---- helpers
const PWA_URL   = process.env.PWA_URL || 'https://rampet.vercel.app';
const ICON_URL  = process.env.PUSH_ICON_URL  || `${PWA_URL}/images/mi_logo_192.png`;
const BADGE_URL = process.env.PUSH_BADGE_URL || ICON_URL;

// Resuelve una plantilla desde plantillas_push o plantillas_mensajes
async function resolveTemplate(templateId, templateData = {}) {
  const cols = ['plantillas_push', 'plantillas_mensajes'];
  for (const col of cols) {
    const doc = await db.collection(col).doc(templateId).get();
    if (doc.exists) {
      const t = doc.data() || {};
      let title = t.titulo_push || t.titulo || 'Club RAMPET';
      let body  = t.cuerpo_push || t.cuerpo || '';

      for (const [k, v] of Object.entries(templateData)) {
        const rx = new RegExp('\\{' + k + '\\}', 'g');
        title = title.replace(rx, String(v ?? ''));
        body  = body.replace(rx, String(v ?? ''));
      }
      // El cuerpo del push debe ser texto plano
      body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { title, body, image: t.imagen_push || null };
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: `Método ${req.method} no permitido.` });
  if (!isAuthorized(req)) return res.status(401).json({ message: 'No autorizado.' });

  try {
    const { title, body, data, tokens, clienteId, templateId, templateData } = req.body || {};

    // 1) Resolver tokens
    let tokenList = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
    let targetClientId = clienteId || null;

    if (!tokenList.length && targetClientId) {
      const snap = await db.collection('clientes').doc(targetClientId).get();
      if (!snap.exists) return res.status(404).json({ message: 'Cliente no encontrado.' });
      tokenList = (snap.data().fcmTokens || []).filter(Boolean);
    }
    if (!tokenList.length) return res.status(400).json({ message: 'No hay tokens para enviar.' });

    // 2) Resolver contenido (plantilla o texto directo)
    let notifTitle = title || 'Club RAMPET';
    let notifBody  = body  || 'Tienes novedades';
    let notifImage = null;

    if (templateId) {
      const tpl = await resolveTemplate(templateId, templateData);
      if (tpl) {
        notifTitle = tpl.title;
        notifBody  = tpl.body;
        notifImage = tpl.image || null;
      }
    }

    // 3) Armar mensaje webpush con icon/badge
    const webpushNotif = { title: notifTitle, body: notifBody, icon: ICON_URL, badge: BADGE_URL };
    if (notifImage) webpushNotif.image = notifImage;

    const msg = {
      tokens: tokenList,
      data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [String(k), String(v ?? '')])),
      webpush: {
        notification: webpushNotif,
        fcmOptions: { link: PWA_URL },
      },
    };

    // 4) Enviar
    const resp = await messaging.sendEachForMulticast(msg);

    // 5) Limpiar tokens inválidos
    const invalid = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
          invalid.push(tokenList[i]);
        }
      }
    });
    if (targetClientId && invalid.length) {
      await db.collection('clientes').doc(targetClientId).update({
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
