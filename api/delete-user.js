// RAMPET – delete-user (POST) con CORS/OPTIONS y API Key
import * as admin from 'firebase-admin';

let adminApp = null;

function getAdmin() {
  if (adminApp) return adminApp;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw) throw new Error('GOOGLE_CREDENTIALS_JSON missing');
  const creds = JSON.parse(raw);

  // Evitar "already exists" en dev
  if (!admin.apps.length) {
    adminApp = admin.initializeApp({
      credential: admin.credential.cert(creds)
    });
  } else {
    adminApp = admin.app();
  }
  return adminApp;
}

// -- CORS helpers -----------------------------------------------------------
function parseOrigins(envVal) {
  return (envVal || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const ALLOWED = parseOrigins(process.env.CORS_ALLOWED_ORIGINS);

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
}

function isPreflight(req) {
  return req.method === 'OPTIONS';
}
// --------------------------------------------------------------------------

export default async function handler(req, res) {
  try {
    applyCors(req, res);

    // Preflight
    if (isPreflight(req)) {
      return res.status(204).end();
    }

    // Método permitido
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Use POST' });
    }

    // Auth por API key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // Body
    let body = {};
    try {
      // Vercel ya parsea JSON, pero por si acaso:
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    const { docId, numeroSocio } = body;
    if (!docId && !numeroSocio) {
      return res.status(400).json({ ok: false, error: 'Falta docId o numeroSocio.' });
    }

    const db = getAdmin().firestore();

    // Resolver docId por numeroSocio si hace falta
    let targetDocId = docId;
    if (!targetDocId && numeroSocio) {
      const snap = await db.collection('clientes')
        .where('numeroSocio', '==', Number(numeroSocio))
        .limit(1)
        .get();
      if (snap.empty) {
        return res.status(404).json({ ok: false, error: 'Cliente no encontrado.' });
      }
      targetDocId = snap.docs[0].id;
    }

    // Borrar doc del cliente
    await db.collection('clientes').doc(targetDocId).delete();

    // Si más adelante guardás tokens en otra colección/subcolección, acá podés limpiarlos.

    return res.status(200).json({ ok: true, deleted: targetDocId });
  } catch (err) {
    console.error('delete-user error', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Server error' });
  }
}
