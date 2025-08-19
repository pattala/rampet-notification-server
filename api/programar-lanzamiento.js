 // /api/proxy-programar-lanzamiento.js  (Node 18.x – Vercel)
// Proxy CORS-friendly hacia el scheduler interno, con secreto solo del lado server.

export const config = { runtime: 'nodejs };

const ALLOWED = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ⚠️ URL del scheduler real (el que agenda en QStash y luego llama a /api/enviar-notificacion-campana)
const SCHEDULER_URL =
  process.env.NOTIF_SCHEDULER_URL ||
  "https://rampet-notification-server-three.vercel.app/api/programar-lanzamiento";

const API_SECRET = process.env.API_SECRET_KEY || process.env.MI_API_SECRET || "";
const PUBLIC_PANEL_TOKEN = process.env.PUBLIC_PANEL_TOKEN || ""; // opcional

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
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-API-Key",
    "Access-Control-Max-Age": "86400",
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowed = originAllowed(origin);

  // Preflight
  if (req.method === "OPTIONS") {
    if (!allowed) return res.status(403).end();
    res.setHeader("Access-Control-Allow-Credentials", "true");
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  if (!allowed) {
    return res
      .status(403)
      .json({ ok: false, error: "Origin not allowed", origin, allowedList: ALLOWED });
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  Object.entries(corsHeaders(origin)).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    // Validación opcional de token público (NO sensible)
    const clientToken = (
      req.headers["x-api-key"] ||
      req.headers["authorization"] ||
      ""
    )
      .toString()
      .replace(/^Bearer\s+/i, "")
      .trim();

    if (PUBLIC_PANEL_TOKEN && clientToken !== PUBLIC_PANEL_TOKEN) {
      return res
        .status(401)
        .json({ ok: false, error: "Unauthorized (public token mismatch)" });
    }

    const body =
      typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");

    // Passthrough al scheduler real con el secreto del lado server
    const r = await fetch(SCHEDULER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_SECRET}`,
      },
      body: JSON.stringify(body),
    });

    // Puede que no siempre sea JSON
    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        schedulerStatus: r.status,
        schedulerBody: data,
      });
    }

    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    console.error("proxy-programar-lanzamiento", err);
    return res
      .status(500)
      .json({ ok: false, error: "Internal error", detail: String(err?.message || err) });
  }
}
