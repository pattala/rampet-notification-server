// /api/programar-notificacion.js (Vercel Node 'nodejs' ESM)
export const config = { runtime: 'nodejs' };

// CORS allowlist (en Vercel: CORS_ALLOWED_ORIGINS="http://127.0.0.1:5500,http://localhost:5500,https://rampet.vercel.app")
const ALLOWED = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Scheduler externo
const SCHEDULER_URL = process.env.NOTIF_SCHEDULER_URL
  || 'https://rampet-notification-server-three.vercel.app/api/programar-notificacion';

// Secreto server-side
const API_SECRET = process.env.API_SECRET_KEY || process.env.MI_API_SECRET || '';
// Token público opcional para validar el panel sin exponer secretos
const PUBLIC_PANEL_TOKEN = process.env.PUBLIC_PANEL_TOKEN || '';

function originAllowed(origin) {
  if (!origin) return false;
  try { return ALLOWED.includes(new URL(origin).origin); }
  catch { return ALLOWED.includes(origin); }
}
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key',
    'Access-Control-Max-Age': '86400',
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const isAllowed = originAllowed(origin);

  if (req.method === 'OPTIONS') {
    if (!isAllowed) return res.status(403).end();
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    Object.entries(corsHeaders(origin)).forEach(([k,v])=>res.setHeader(k,v));
    return res.status(204).end();
  }
  if (!isAllowed) return res.status(403).json({ ok:false, error:'Origin not allowed', origin });

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  Object.entries(corsHeaders(origin)).forEach(([k,v])=>res.setHeader(k,v));

  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try {
    const clientToken = (req.headers['x-api-key'] || req.headers['authorization'] || '')
      .toString().replace(/^Bearer\s+/i,'').trim();

    if (PUBLIC_PANEL_TOKEN && clientToken !== PUBLIC_PANEL_TOKEN) {
      return res.status(401).json({ ok:false, error:'Unauthorized (public token mismatch)' });
    }

    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

    const resp = await fetch(SCHEDULER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_SECRET}`, // secreto solo del lado server
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json().catch(()=>({}));
    if (!resp.ok) {
      return res.status(resp.status).json({ ok:false, schedulerStatus: resp.status, schedulerBody: data });
    }
    return res.status(200).json({ ok:true, result: data });
  } catch (err) {
    console.error('programar-notificacion error', err);
    return res.status(500).json({ ok:false, error:'Internal error', detail: String(err?.message||err) });
  }
}
