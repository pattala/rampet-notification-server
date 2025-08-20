// api/delete-user.js
// Handler con CORS unificado + x-api-key + borrado flexible en Firestore (y opcional en Auth)

import admin from 'firebase-admin';

// ---------- Inicialización Firebase Admin ----------
function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw) {
    throw new Error('GOOGLE_CREDENTIALS_JSON missing');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error('Invalid GOOGLE_CREDENTIALS_JSON (not valid JSON)');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function getDb() {
  initFirebaseAdmin();
  return admin.firestore();
}

// ---------- Utilidades CORS ----------
function getAllowedOrigin(req) {
  const allowed = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) return origin;
  // Fallback: si no viene un Origin permitido, usa el primero configurado (o no setea nada)
  return allowed[0] || '';
}

function setCors(res, origin) {
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
}

// ---------- Búsqueda del documento del cliente ----------
async function findClienteDoc(db, { docId, numeroSocio, authUID, email }) {
  const col = db.collection('clientes');

  if (docId) {
    const snap = await col.doc(docId).get();
    if (snap.exists) return { id: snap.id, data: snap.data() };
  }

  if (numeroSocio != null && numeroSocio !== '') {
    const q = await col.where('numeroSocio', '==', Number(numeroSocio)).limit(1).get();
    if (!q.empty) {
      const doc = q.docs[0];
      return { id: doc.id, data: doc.data() };
    }
  }

  if (authUID) {
    const q = await col.where('authUID', '==', authUID).limit(1).get();
    if (!q.empty) {
      const doc = q.docs[0];
      return { id: doc.id, data: doc.data() };
    }
  }

  if (email) {
    const q = await col.where('email', '==', String(email).toLowerCase()).limit(1).get();
    if (!q.empty) {
      const doc = q.docs[0];
      return { id: doc.id, data: doc.data() };
    }
  }

  return null;
}

// ---------- Handler principal ----------
export default async function handler(req, res) {
  const allowOrigin = getAllowedOrigin(req);
  setCors(res, allowOrigin);

  if (req.method === 'OPTIONS') {
    // Preflight
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    // Ping/sanidad de ruta
    return res.status(200).json({
      ok: true,
      route: '/api/delete-user',
      corsOrigin: allowOrigin || null,
      project: 'sistema-fidelizacion',
      tips: 'Use POST con x-api-key y body { docId | numeroSocio | authUID | email, deleteAuth? }',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  // Seguridad básica por API key (alineado con send-notification)
  const clientKey = req.headers['x-api-key'];
  if (!clientKey || clientKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const db = getDb();

    // Body esperado:
    // { docId?: string, numeroSocio?: number|string, authUID?: string, email?: string, deleteAuth?: boolean }
    const { docId, numeroSocio, authUID, email, deleteAuth } = req.body || {};

    if (!docId && !numeroSocio && !authUID && !email) {
      return res.status(400).json({
        ok: false,
        error: 'Parámetros inválidos. Envíe al menos uno: docId | numeroSocio | authUID | email',
      });
    }

    const found = await findClienteDoc(db, { docId, numeroSocio, authUID, email });
    if (!found) {
      return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });
    }

    const { id, data } = found;

    // Borrar documento en Firestore
    await db.collection('clientes').doc(id).delete();

    // Borrado opcional en Firebase Auth
    let authDeletion = null;
    const authToDelete = authUID || data?.authUID;
    if (deleteAuth && authToDelete) {
      try {
        initFirebaseAdmin();
        await admin.auth().deleteUser(authToDelete);
        authDeletion = { deleted: true, uid: authToDelete };
      } catch (e) {
        // No cortar la operación si Auth falla: devolvemos aviso
        authDeletion = { deleted: false, uid: authToDelete, error: e?.message || String(e) };
      }
    }

    return res.status(200).json({
      ok: true,
      deletedDocId: id,
      matchedBy: docId ? 'docId' : authUID ? 'authUID' : email ? 'email' : 'numeroSocio',
      authDeletion,
    });
  } catch (err) {
    console.error('delete-user error:', err);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
