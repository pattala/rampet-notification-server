// /api/set-admin-claim.js
const admin = require('firebase-admin');

// Leemos la clave secreta desde las variables de entorno de Vercel
const MI_API_SECRET = process.env.API_SECRET_KEY; 

// Inicializa la app de Firebase Admin si no lo ha hecho ya
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

export default async function handler(req, res) {
  // 1. Proteger el endpoint
  const authHeader = req.headers.authorization;
  if (req.method !== 'POST' || authHeader !== `Bearer ${MI_API_SECRET}`) {
    return res.status(403).json({ error: 'Acceso no autorizado.' });
  }

  // 2. Obtener el email del cuerpo de la petición
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Falta el email en el cuerpo de la petición.' });
  }

  try {
    // 3. Buscar el usuario por email
    const userRecord = await admin.auth().getUserByEmail(email);
    
    // 4. Asignar el custom claim "admin: true"
    await admin.auth().setCustomUserClaims(userRecord.uid, { admin: true });

    return res.status(200).json({ message: `¡Éxito! El usuario ${email} ahora es administrador.` });
  } catch (error) {
    console.error('Error asignando el claim de admin:', error);
    return res.status(500).json({ error: 'No se pudo asignar el rol de administrador.', details: error.message });
  }
}
