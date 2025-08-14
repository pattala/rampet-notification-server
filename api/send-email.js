// /api/send-email.js (ESM) — Email con plantillas unificadas, CORS, auth y SendGrid
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import sgMail from '@sendgrid/mail';
import { resolveTemplate, applyBlocksAndVars } from '../utils/templates.js';

// --- Init Firebase Admin ---
if (!getApps().length) {
  const creds = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : null;
  initializeApp(creds ? { credential: cert(creds) } : {});
}
const db = getFirestore();
const adminAuth = getAuth();

// --- SendGrid ---
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

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
async function authCheck(req) {
  const origin = req.headers.origin || '';
  const apiKey = req.headers['x-api-key'] || null;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (apiKey && apiKey === process.env.API_SECRET_KEY) return { ok: true, mode: 'secret' };
  if (token && (token === process.env.API_SECRET_KEY || token === process.env.MI_API_SECRET)) return { ok: true, mode: 'secret' };

  if (token) {
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      if (decoded) return { ok: true, mode: 'idToken' };
    } catch { /* ignore */ }
  }

  if (ALLOWED.includes(origin)) return { ok: true, mode: 'origin' };

  return { ok: false, reason: token ? 'token-mismatch' : 'no-auth-header', origin };
}

function buildHtmlLayout(innerHtml) {
  const base = process.env.PWA_URL || 'https://rampet.vercel.app';
  const logo = process.env.PUSH_ICON_URL || `${base}/images/mi_logo.png`;
  const terms = process.env.URL_TERMINOS_Y_CONDICIONES || '#';
  return `<!doctype html>
  <html lang="es">
    <head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Club RAMPET</title></head>
    <body style="background:#f7f7f7;padding:0;margin:0;font-family:Arial,Helvetica,sans-serif;color:#111;">
      <table width="100%" cellspacing="0" cellpadding="0" style="background:#f7f7f7;padding:24px 0;">
        <tr><td align="center">
          <table width="600" cellspacing="0" cellpadding="0" style="background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eee;">
            <tr><td style="background:#0ea5e9;height:6px;"></td></tr>
            <tr><td style="padding:16px;text-align:center;"><img src="${logo}" alt="Logo" style="max-width:140px;height:auto"/></td></tr>
            <tr><td style="padding:16px 24px;font-size:16px;line-height:1.5;">${innerHtml}</td></tr>
            <tr><td style="padding:16px 24px;text-align:center;color:#666;font-size:12px;">
              <a href="${base}" style="color:#0ea5e9;text-decoration:none;">Abrir App</a> · 
              <a href="${terms}" style="color:#0ea5e9;text-decoration:none;">Términos</a> · 
              © ${new Date().getFullYear()} RAMPET
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
  </html>`;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: `Método ${req.method} no permitido.` });

  const auth = await authCheck(req);
  if (!auth.ok) {
    console.warn('send-email unauthorized', { reason: auth.reason, origin: auth.origin || null });
    return res.status(401).json({ message: 'No autorizado.' });
  }

  try {
    const { to, templateId, templateData = {} } = req.body || {};
    if (!to || !templateId) return res.status(400).json({ message: 'Faltan parámetros: to y templateId.' });

    // 1) Plantilla unificada (con fallback legacy)
    const tpl = await resolveTemplate(db, templateId, 'email');
    const subject = applyBlocksAndVars(tpl.titulo, { ...templateData, email: to });
    const htmlInner = applyBlocksAndVars(tpl.cuerpo,  { ...templateData, email: to });
    const html = buildHtmlLayout(htmlInner);

    const fromEmail = process.env.SENDGRID_FROM_EMAIL;
    const apiKey = process.env.SENDGRID_API_KEY;

    // 2) Si falta SendGrid, devolvemos preview para debug
    if (!apiKey || !fromEmail) {
      return res.status(200).json({ ok: true, preview: true, to, subject, html });
    }

    // 3) Enviar con SendGrid
    await sgMail.send({ to, from: { email: fromEmail, name: 'Club RAMPET' }, subject, html });
    return res.status(200).json({ ok: true, sent: true, to, subject });
  } catch (error) {
    console.error('Error fatal procesando el email:', error);
    if (error?.response) console.error(error.response.body);
    return res.status(500).json({ message: 'Error interno del servidor.', error: error.message });
  }
}
