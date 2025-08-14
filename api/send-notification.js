// /api/send-notification.js (ESM) — Push con plantillas, CORS y limpieza de tokens
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { resolveTemplate, applyBlocksAndVars, sanitizePush } from '../utils/templates.js';

// --- Init Firebase Admin ---
if (!getApps().length) {
  const creds = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : null;
  initializeApp(creds ? { credential: cert(creds) } : {});
}
const db = getFirestore();
const messaging = getMessaging();

// --- CORS ---
const ALLOWED = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// --- Auth ---
function isAuthorized(req) {
  const origin = req.headers.origin || '';
  const apiKey = req.headers['x-api-key'] || null;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (apiKey && apiKey === process.env.API_SECRET_KEY) return true;
  if (token && (token === process.env.API_SECRET_KEY || token === process.env.MI_API_SECRET)) return true;
  if (ALLOWED.includes(origin)) return true; // panel por CORS
  return false;
}

// --- Config push ---
const PWA_URL   = process.env.PWA_URL || 'https://rampet.vercel.app';
const ICON_URL  = process.env.PUSH_ICON_URL  || `${PWA_URL}/images/mi_logo.png`;
const BADGE_URL = process.env.PUSH_BADGE_URL || ICON_URL;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: `Método ${req.method} no permitido.` });
  if (!isAuthorized(req)) return res.status(401).json({ message: 'No autorizado.' });

  try {
    let { title, body, data, tokens, clienteId, templateId, templateData = {} } = req.body || {};

    // 1) Tokens destino
    let tokenList = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
    const targetClientId = clienteId || null;

    if (!tokenList.length && targetClientId) {
      const snap = await db.collection('clientes').doc(String(targetClientId)).get();
      if (!snap.exists) return res.status(404).json({ message: 'Cliente no encontrado.' });
      tokenList = Array.isArray(snap.data()?.fcmTokens) ? snap.data().fcmTokens.filter(Boolean) : [];
    }
    if (!tokenList.length) return res.status(400).json({ message: 'No hay tokens para enviar.' });

    // 2) Contenido (plantilla o texto directo)
    let notifTitle = title || 'Club RAMPET';
    let notifBody  = body  || 'Tienes novedades';

    if (templateId) {
      const tpl = await resolveTemplate(db, templateId, 'push');
      notifTitle = sanitizePush(applyBlocksAndVars(tpl.titulo, templateData));
      notifBody  = sanitizePush(applyBlocksAndVars(tpl.cuerpo,  templateData));
    } else {
      notifTitle = sanitizePush(applyBlocksAndVars(notifTitle, templateData));
      notifBody  = sanitizePush(applyBlocksAndVars(notifBody,  templateData));
    }

    // 3) Mensaje webpush
    const webpushNotif = { title: notifTitle, body: notifBody, icon: ICON_URL, badge: BADGE_URL };
    const msg = {
      tokens: tokenList,
      data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [String(k), String(v ?? '')])),
      webpush: { notification: webpushNotif, fcmOptions: { link: PWA_URL } },
    };

    // 4) Enviar
    const resp = await messaging.sendEachForMulticast(msg);

    // 5) Limpiar tokens inválidos
    const invalid = [];
    resp.responses?.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
          invalid.push(tokenList[i]);
        }
      }
    });
    if (targetClientId && invalid.length) {
      const ref = db.collection('clientes').doc(String(targetClientId));
      await ref.update({ fcmTokens: FieldValue.arrayRemove(...invalid) });
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
