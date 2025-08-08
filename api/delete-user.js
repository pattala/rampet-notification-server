// api/delete-user.js (Versión Limpia)

const admin = require('firebase-admin');

// --- Helper para inicializar Firebase Admin ---
function initializeFirebaseAdmin() {
    if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
    }
    return admin.firestore();
}

export default async function handler(req, res) {
    // La lógica de CORS y OPTIONS ha sido eliminada y centralizada en vercel.json
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido.' });
    }

    const db = initializeFirebaseAdmin();
    try {
        const idToken = req.headers.authorization?.split('Bearer ')[1];
        if (!idToken) return res.status(401).json({ error: 'No autorizado: Token no proporcionado.' });

        const decodedToken = await admin.auth().verifyIdToken(idToken);
        if (!decodedToken.admin) return res.status(403).json({ error: 'No autorizado: El usuario no es administrador.' });

        const { clienteId, authUID } = req.body;
        if (!clienteId) return res.status(400).json({ error: 'Falta el ID del documento del cliente.' });

        await db.collection('clientes').doc(clienteId).delete();
        console.log(`Documento de Firestore ${clienteId} eliminado.`);

        if (authUID) {
            try {
                await admin.auth().deleteUser(authUID);
                console.log(`Usuario de Authentication ${authUID} eliminado.`);
            } catch (error) {
                if (error.code === 'auth/user-not-found') {
                    console.warn(`El usuario de Authentication ${authUID} no fue encontrado. Puede que ya haya sido eliminado.`);
                } else {
                    // Loguear otros posibles errores sin detener el flujo principal
                    console.error(`Error al eliminar usuario de Authentication ${authUID}:`, error);
                }
            }
        }

        return res.status(200).json({ message: 'Cliente eliminado con éxito.' });

    } catch (error) {
        console.error('Error en API /delete-user:', error);
        return res.status(500).json({ error: 'Error interno del servidor.', details: error.message });
    }
}
