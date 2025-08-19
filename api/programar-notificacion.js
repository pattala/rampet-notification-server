// /api/programar-notificacion.js (Vercel runtime "nodejs" – ESM)

export const config = { runtime: 'nodejs' };

const ALLOWED = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const INTERNAL_TOKEN = process.env.API_SECRET_KEY || process.env.MI_API_SECRET || '';

const SCHEDULER_URL =
  process.env.NOTIF_SCHEDULER_URL
  || `https://${process.env.VERCEL_URL || 'rampet-notification-server-three.vercel.app'}/api/send-notification`;

function originAllowed(origin) {
  if (!origin) return false;
  try { return ALLOWED.includes(new URL(origin).origin); }
  catch { return ALLOWED.includes(origin); }
}
function isInternal(req) {
  const raw = (req.headers['authorization'] || req.headers['x-api-key'] || '')
    .toString().replace(/^Bearer\s+/i,'').trim();
  return !!raw && raw === INTERNAL_TOKEN;
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
  const allowed = originAllowed(origin) || isInternal(req);

  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end();
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    Object.entries(corsHeaders(origin || (ALLOWED[0] || '*'))).forEach(([k,v]) => res.setHeader(k,v));
    return res.status(204).end();
  }

  if (!allowed) return res.status(403).json({ ok:false, error:'Origin not allowed', origin });
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  Object.entries(corsHeaders(origin || (ALLOWED[0] || '*'))).forEach(([k,v]) => res.setHeader(k,v));

  try {
    const payload = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

    const r = await fetch(SCHEDULER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ ok:false, schedulerStatus:r.status, schedulerBody:data });
    }
    return res.status(200).json({ ok:true, result:data });
  } catch (err) {
    console.error('programar-notificacion error:', err);
    return res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
}
