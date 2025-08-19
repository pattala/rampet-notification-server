// /api/programar-lanzamiento.js (Vercel Node 'nodejs' ESM)
// ✅ Vercel sólo acepta "nodejs" / "edge"
export const config = { runtime: 'nodejs' };

const ALLOWED = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Token interno para permitir llamadas server-to-server (sin Origin)
const INTERNAL_TOKEN = process.env.API_SECRET_KEY || process.env.MI_API_SECRET;

function originAllowed(origin) {
  if (!origin) return false;
  try { return ALLOWED.includes(new URL(origin).origin); }
  catch { return ALLOWED.includes(origin); }
}

// ✅ si viene con Authorization: Bearer <API_SECRET>, lo tratamos como interno
function isInternal(req) {
  const raw = (req.headers['authorization'] || req.headers['x-api-key'] || '')
    .toString().replace(/^Bearer\s+/i,'').trim();
  return raw && raw === INTERNAL_TOKEN;
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





const SCHEDULER_URL = process.env.NOTIF_SCHEDULER_URL
  // 👉 apunta al worker que procesa el envío real (NO a programar-lanzamiento otra vez)
  || `https://${process.env.VERCEL_URL || 'rampet-notification-server-three.vercel.app'}/api/send-notification`;


const API_SECRET = process.env.API_SECRET_KEY || process.env.MI_API_SECRET || '';
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
  const origin  = req.headers.origin || '';
  const allowed = originAllowed(origin) || isInternal(req);   // ✅ permite internas

  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end();
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    Object.entries(corsHeaders(origin || (ALLOWED[0] || '*'))).forEach(([k,v])=>res.setHeader(k,v));
    return res.status(204).end();
  }

  if (!allowed) {
    return res.status(403).json({ ok:false, error:'Origin not allowed', origin });
  }

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  Object.entries(corsHeaders(origin || (ALLOWED[0] || '*'))).forEach(([k,v])=>res.setHeader(k,v));

  if (req.method !== 'POST') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }
  try {
    const clientToken = (req.headers['x-api-key'] || req.headers['authorization'] || '')
      .toString().replace(/^Bearer\s+/i,'').trim();
    if (PUBLIC_PANEL_TOKEN && clientToken !== PUBLIC_PANEL_TOKEN) {
      return res.status(401).json({ ok:false, error:'Unauthorized (public token mismatch)' });
    }

    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

    const r = await fetch(SCHEDULER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_SECRET}`, // secreto server-side
      },
      body: JSON.stringify(body),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ ok:false, schedulerStatus:r.status, schedulerBody:data });
    }
    return res.status(200).json({ ok:true, result: data });
  } catch (err) {
    console.error('proxy-programar-lanzamiento', err);
    return res.status(500).json({ ok:false, error:'Internal error', detail:String(err?.message||err) });
  }
}
