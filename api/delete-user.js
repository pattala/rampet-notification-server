// /api/delete-user.js
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
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido.' });
    }

    const db = initializeFirebaseAdmin();

    try {
        // 1. Verificación de Autenticación del Administrador
        const idToken = req.headers.authorization?.split('Bearer ')[1];
        if (!idToken) {
            return res.status(401).json({ error: 'No autorizado: Token no proporcionado.' });
        }
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        if (!decodedToken.admin) {
            return res.status(403).json({ error: 'No autorizado: El usuario no es administrador.' });
        }

        // 2. Extracción de datos del cuerpo de la petición
        const { clienteId, authUID } = req.body;
        if (!clienteId) {
            return res.status(400).json({ error: 'Falta el ID del documento del cliente.' });
        }

        // 3. Borrado del documento en Firestore
        await db.collection('clientes').doc(clienteId).delete();
        console.log(`Documento de Firestore ${clienteId} eliminado.`);

        // 4. Borrado del usuario en Firebase Authentication (si tiene authUID)
        // Esto es crucial para los usuarios registrados desde la PWA.
        if (authUID) {
            try {
                await admin.auth().deleteUser(authUID);
                console.log(`Usuario de Authentication ${authUID} eliminado.`);
            } catch (error) {
                // Si el usuario ya fue eliminado de Auth o nunca existió, no tratamos esto como un error fatal.
                if (error.code === 'auth/user-not-found') {
                    console.warn(`El usuario de Authentication ${authUID} no fue encontrado. Es posible que ya haya sido eliminado.`);
                } else {
                    // Si es otro error, lo registramos pero continuamos, ya que el borrado de Firestore es lo más crítico.
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
