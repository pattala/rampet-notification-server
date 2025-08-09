// /api/send-notification.js (push con plantillas, bloques, icon y CORS)
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
  .split(',').map(s => s.trim()).filter(Boolean);

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

// ---- Config push
const PWA_URL   = process.env.PWA_URL || 'https://rampet.vercel.app';
const ICON_URL  = process.env.PUSH_ICON_URL  || `${PWA_URL}/images/mi_logo.png`;   // <- CAMBIO: usar mi_logo.png
const BADGE_URL = process.env.PUSH_BADGE_URL || ICON_URL;

// Alias cómodos (si mandás { tipo: 'compra' } en vez de templateId)
const TEMPLATE_ALIASES = {
  compra: 'push_compra',
  puntos: 'push_puntos',
  bono: 'push_bono_especial',
  bienvenida: 'bienvenida_push',
};

// Aplica bloques y reemplazos
function applyBlocksAndVars(text, data) {
  let out = text || '';

  // Bloques condicionales (mismos que en email, los que te afectan al push)
  out = out.replace(
    /\[BLOQUE_VENCIMIENTO\]/g,
    data?.vencimiento_text ? `Vencen el: ${data.vencimiento_text}` : ''
  );
  out = out.replace(
    /\[BLOQUE_PUNTOS_BIENVENIDA\]([\s\S]*?)\[\/BLOQUE_PUNTOS_BIENVENIDA\]/g,
    (_, block) => (Number(data?.puntos_ganados) > 0 ? block : '')
  );
  out = out.replace(
    /\[BLOQUE_CREDENCIALES_PANEL\]([\s\S]*?)\[\/BLOQUE_CREDENCIALES_PANEL\]/g,
    '' // normalmente esto no va en push
  );

  // Reemplazo {clave}
  for (const [k, v] of Object.entries(data || {})) {
    out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v ?? ''));
  }

  // El cuerpo del push debe ser texto plano
  out = out.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return out;
}

// Resuelve una plantilla desde plantillas_push o plantillas_mensajes
async function resolveTemplate(templateId, templateData = {}) {
  const cols = ['plantillas_push', 'plantillas_mensajes'];
  for (const col of cols) {
    const snap = await db.collection(col).doc(templateId).get();
    if (snap.exists) {
      const t = snap.data() || {};
      let title = t.titulo_push || t.titulo || 'Club RAMPET';
      let body  = t.cuerpo_push || t.cuerpo || '';
      title = applyBlocksAndVars(title, templateData);
      body  = applyBlocksAndVars(body,  templateData);
      const image = t.imagen_push || null;
      return { title, body, image };
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: `Método ${req.method} no permitido.` });
  if (!isAuthorized(req)) return res.status(401).json({ message: 'No autorizado.' });

  try {
    let { title, body, data, tokens, clienteId, templateId, templateData, tipo } = req.body || {};

    // Resolver alias de plantilla (si vino "tipo")
    if (!templateId && tipo && TEMPLATE_ALIASES[tipo]) {
      templateId = TEMPLATE_ALIASES[tipo];
    }

    // 1) Tokens destino
    let tokenList = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
    let targetClientId = clienteId || null;

    if (!tokenList.length && targetClientId) {
      const snap = await db.collection('clientes').doc(targetClientId).get();
      if (!snap.exists) return res.status(404).json({ message: 'Cliente no encontrado.' });
      tokenList = (snap.data().fcmTokens || []).filter(Boolean);
    }
    if (!tokenList.length) return res.status(400).json({ message: 'No hay tokens para enviar.' });

    // 2) Contenido (plantilla o texto directo)
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
    } else {
      // Si mandaste title/body “crudos”, por las dudas aplicar reemplazos
      notifTitle = applyBlocksAndVars(notifTitle, templateData);
      notifBody  = applyBlocksAndVars(notifBody,  templateData);
    }

    // 3) Mensaje webpush con icon/badge (logo)
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
