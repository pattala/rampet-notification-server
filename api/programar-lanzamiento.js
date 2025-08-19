// /api/programar-lanzamiento.js  (Vercel Node 'nodejs' - ESM limpio)
// CORS se maneja en vercel.json. Aquí sólo forward y OPTIONS 204.

export const config = { runtime: "nodejs" };

const API_SECRET = process.env.API_SECRET_KEY || process.env.MI_API_SECRET || "";

// Por defecto, manda al worker que hace el envío real.
// Si definís NOTIF_SCHEDULER_URL, se usa ése.
const SCHEDULER_URL =
  process.env.NOTIF_SCHEDULER_URL ||
  `https://${process.env.VERCEL_URL || "rampet-notification-server-three.vercel.app"}/api/send-notification`;

export default async function handler(req, res) {
  // Preflight simple (los headers los inyecta Vercel desde vercel.json)
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    // body seguro
    const body =
      typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");

    // forward server-to-server con el secreto interno
    const r = await fetch(SCHEDULER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_SECRET}`,
      },
      body: JSON.stringify(body),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res
        .status(r.status)
        .json({ ok: false, schedulerStatus: r.status, schedulerBody: data });
    }

    return res.status(200).json({ ok: true, result: data });
  } catch (err) {
    console.error("programar-lanzamiento error:", err);
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
}
