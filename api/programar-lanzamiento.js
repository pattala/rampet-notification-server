// /api/programar-lanzamiento.js (Vercel runtime "nodejs" – ESM)

// 👉 Vercel sólo acepta: 'nodejs' | 'edge'
export const config = { runtime: 'nodejs' };

// ----- C O N F I G -----
const ALLOWED = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Secreto interno para llamadas server-to-server (panel NO lo usa)
const INTERNAL_TOKEN = process.env.API_SECRET_KEY || process.env.MI_API_SECRET || '';

// Worker real que ejecuta el envío (NUNCA apuntar a este mismo endpoint)
const SCHEDULER_URL = (
  process.env.NOTIF_SCHEDULER_URL
  || `https://${process.env.VERCEL_URL || 'rampet-notification-server-three.vercel.app'}/api/send-notification`
);

// ----- H E L P E R S  C O R S -----
function originAllowed(origin) {
  if (!origin) return false;
  try {
    return ALLOWED.includes(new URL(origin).origin);
  } catch {
    return ALLOWED.includes(origin);
  }
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

function isInternal(req) {
  const raw = (req.headers['authorization'] || req.headers['x-api-key'] || '')
    .toString()
    .replace(/^Bearer\s+/i, '')
    .trim();
  return !!raw && raw === INTERNAL_TOKEN;
}

// ----- H A N D L E R -----
export default async function handler(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = originAllowed(origin) || isInternal(req);

  // Preflight
  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end();
    // Headers CORS
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    Object.entries(corsHeaders(origin || (ALLOWED[0] || '*'))).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  // Solo POST
  if (!allowed) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed', origin });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // CORS en la respuesta real
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  Object.entries(corsHeaders(origin || (ALLOWED[0] || '*'))).forEach(([k, v]) => res.setHeader(k, v));

  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

    // Reenvío al worker real con el secreto interno (server-to-server)
    const r = await fetch(SCHEDULER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, schedulerStatus: r.status, schedulerBody: data });
    }
    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    console.error('programar-lanzamiento error:', err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
