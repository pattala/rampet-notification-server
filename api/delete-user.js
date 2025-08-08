// /api/delete-user.js (VERSIÓN FINAL CON MANEJO DE OPTIONS)
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

// --- INICIO: LÓGICA DE CORS ---
const allowedOrigins = [
    'http://127.0.0.1:5500', // Tu servidor local
    'http://localhost:5500',   // Otra forma de acceder localmente
    // 'https://admin-rampet.vercel.app' 
];

function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
}
// --- FIN: LÓGICA DE CORS ---

export default async function handler(req, res) {
    // Aplicamos los headers de CORS a todas las respuestas
    setCorsHeaders(req, res);

    // --- INICIO: NUEVO BLOQUE PARA MANEJAR OPTIONS ---
    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }
    // --- FIN: NUEVO BLOQUE ---
    
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
                    console.warn(`El usuario de Authentication ${authUID} no fue encontrado.`);
                } else {
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
