// /api/send-email.js (ESM + CORS + auth flexible + SendGrid)
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import sgMail from '@sendgrid/mail';

// --- Init Firebase Admin ---
if (!getApps().length) {
  const creds = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : null;
  if (creds) initializeApp({ credential: cert(creds) });
  else initializeApp();
}
const db = getFirestore();
const adminAuth = getAuth();

// --- SendGrid ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- CORS ---
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
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

async function isAuthorized(req) {
  const origin = req.headers.origin || '';
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  // 1) Secreto server→server (acepta API_SECRET_KEY y, por compatibilidad, MI_API_SECRET)
  if (token && (token === process.env.API_SECRET_KEY || token === process.env.MI_API_SECRET)) {
    return true;
  }

  // 2) idToken de Firebase (si alguna vez lo usás desde el panel)
  if (token) {
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      // Si quisieras exigir rol admin: if (!decoded.admin) return false;
      return !!decoded;
    } catch {
      /* sigue abajo */
    }
  }

  // 3) Fallback temporal: permitir sin Authorization si el origin está permitido
  if (ALLOWED.includes(origin)) return true;

  return false;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ message: `Método ${req.method} no permitido.` });
  }

  // Auth flexible
  if (!(await isAuthorized(req))) {
    return res.status(401).json({ message: 'No autorizado.' });
  }

  try {
    const { to, templateId, templateData } = req.body || {};
    if (!to || !templateId) {
      return res.status(400).json({ message: 'Faltan parámetros: to y templateId son requeridos.' });
    }

    // Plantilla desde Firestore
    const snap = await db.collection('plantillas_mensajes').doc(templateId).get();
    if (!snap.exists) {
      return res.status(404).json({ message: `Plantilla '${templateId}' no encontrada.` });
    }

    const plantilla = snap.data() || {};
    let subject = plantilla.titulo || 'Notificación de Club RAMPET';
    let body = plantilla.cuerpo || '';

    const full = {
      ...templateData,
      email: to,
      pwa_url: process.env.PWA_URL || '#',
      link_terminos: process.env.URL_TERMINOS_Y_CONDICIONES || '#'
    };

    // Bloques condicionales
    body = body.replace(
      /\[BLOQUE_PUNTOS_BIENVENIDA\]([\s\S]*?)\[\/BLOQUE_PUNTOS_BIENVENIDA\]/g,
      (_, block) => (Number(full.puntos_ganados) > 0 ? block : '')
    );
    body = body.replace(
      /\[BLOQUE_CREDENCIALES_PANEL\]([\s\S]*?)\[\/BLOQUE_CREDENCIALES_PANEL\]/g,
      (_, block) => (full.creado_desde_panel ? block : '')
    );

    // Marcador simple de vencimiento (si viene texto)
    body = body.replace(
      /\[BLOQUE_VENCIMIENTO\]/g,
      full.vencimiento_text ? `<p>Vencen el: <strong>${full.vencimiento_text}</strong></p>` : ''
    );

    // Reemplazos {clave}
    for (const k of Object.keys(full)) {
      const val = full[k] ?? '';
      const rx = new RegExp('\\{' + k + '\\}', 'g');
      body = body.replace(rx, String(val));
      subject = subject.replace(rx, String(val));
    }

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; line-height:1.6; max-width:600px; margin:auto; padding:20px;">
        <img src="https://raw.githubusercontent.com/pattala/rampet-cliente-app/main/images/mi_logo.png" alt="Logo RAMPET" style="width:150px; display:block; margin:0 auto 20px;">
        <h2 style="color:#0056b3;">${subject}</h2>
        <div>${body}</div><br>
        <p>Atentamente,<br><strong>El equipo de Club RAMPET</strong></p>
        <br>Hipólito Yrigoyen 112, Martínez
        <br>📞 (11) 3937-1215
      </div>`;

    await sgMail.send({
      to,
      from: { email: process.env.SENDGRID_FROM_EMAIL, name: 'Club RAMPET' },
      subject,
      html: htmlBody
    });

    return res.status(200).json({ ok: true, message: 'Email enviado con éxito.' });
  } catch (error) {
    console.error('Error fatal procesando el email:', error);
    if (error.response) console.error(error.response.body);
    return res.status(500).json({ message: 'Error interno del servidor.', error: error.message });
  }
}
