//  /api/set-admin-claim.js (ESM)
import admin from 'firebase-admin';

const MI_API_SECRET = process.env.API_SECRET_KEY || process.env.MI_API_SECRET || '';

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

export default async function handler(req, res) {
  // Proteger con Bearer del secreto
  const authHeader = req.headers.authorization || '';
  if (req.method !== 'POST' || authHeader !== `Bearer ${MI_API_SECRET}`) {
    return res.status(403).json({ error: 'Acceso no autorizado.' });
  }

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Falta el email.' });

  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(userRecord.uid, { admin: true });
    return res.status(200).json({ message: `¡Éxito! ${email} ahora es administrador.` });
  } catch (error) {
    console.error('Error asignando claim:', error);
    return res.status(500).json({ error: 'No se pudo asignar el rol.', details: error.message });
  }
}
