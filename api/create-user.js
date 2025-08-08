// /api/create-user.js (VERSIÓN FINAL CON MANEJO DE OPTIONS)
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

// --- Helper para obtener días de caducidad ---
function getDiasCaducidad(puntos, reglasCaducidad) {
    if (!reglasCaducidad || reglasCaducidad.length === 0) return 90;
    const regla = [...reglasCaducidad].sort((a, b) => b.minPuntos - a.minPuntos).find(r => puntos >= r.minPuntos);
    if (!regla && reglasCaducidad.length > 0) return [...reglasCaducidad].sort((a,b) => a.minPuntos - b.minPuntos)[0].cadaDias;
    return regla ? regla.cadaDias : 90;
}

// --- INICIO: LÓGICA DE CORS ---
const allowedOrigins = [
    'http://127.0.0.1:5500', // Tu servidor local
    'http://localhost:5500',   // Otra forma de acceder localmente
    // Aquí puedes añadir la URL de tu panel cuando lo subas a Vercel
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
// Aplicamos los headers de CORS a todas las respuestas
    setCorsHeaders(req, res);

    // El navegador envía una petición "pre-vuelo" OPTIONS antes del POST
    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }
    // --- INICIO: NUEVO BLOQUE PARA MANEJAR OPTIONS ---
    // El navegador envía una petición "pre-vuelo" OPTIONS antes del POST
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

        const { dni, nombre, email, telefono, fechaNacimiento, fechaInscripcion, enviarBienvenida, bonoBienvenida } = req.body;
        if (!dni || !nombre || !email) return res.status(400).json({ error: 'DNI, Nombre y Email son obligatorios.' });

        const emailQuery = await db.collection('clientes').where('email', '==', email).limit(1).get();
        if (!emailQuery.empty) return res.status(409).json({ error: `Conflicto: El email '${email}' ya está en uso por otro cliente.` });
        
        const dniQuery = await db.collection('clientes').where('dni', '==', dni).limit(1).get();
        if (!dniQuery.empty) return res.status(409).json({ error: `Conflicto: El DNI '${dni}' ya está en uso por otro cliente.` });

        const userRecord = await admin.auth().createUser({ email: email, password: dni, displayName: nombre });
        const authUID = userRecord.uid;

        const contadorRef = db.collection("configuracion").doc("contadores");
        const clienteRef = db.collection('clientes').doc();
        const nuevoNumeroSocio = await db.runTransaction(async (transaction) => {
            const contadorDoc = await transaction.get(contadorRef);
            let numero = 1;
            if (contadorDoc.exists && contadorDoc.data().ultimoNumeroSocio) {
                numero = contadorDoc.data().ultimoNumeroSocio + 1;
            }
            transaction.set(contadorRef, { ultimoNumeroSocio: numero }, { merge: true });
            return numero;
        });

        const nuevoCliente = {
            id: clienteRef.id, numeroSocio: nuevoNumeroSocio, authUID: authUID,
            dni, nombre, email, telefono, fechaNacimiento, fechaInscripcion,
            puntos: 0, saldoAcumulado: 0, totalGastado: 0, ultimaCompra: "",
            historialPuntos: [], historialCanjes: [], fcmTokens: [],
            terminosAceptados: true, passwordPersonalizada: false,
        };
        
        if (bonoBienvenida.activo && bonoBienvenida.puntos > 0) {
            const configDoc = await db.collection('configuracion').doc('sistema').get();
            const config = configDoc.data() || {};
            const puntosBono = bonoBienvenida.puntos;
            nuevoCliente.puntos += puntosBono;
            nuevoCliente.historialPuntos.push({
                fechaObtencion: new Date().toISOString(),
                puntosObtenidos: puntosBono,
                puntosDisponibles: puntosBono,
                origen: 'Bono de Bienvenida',
                diasCaducidad: getDiasCaducidad(puntosBono, config.reglasCaducidad)
            });
        }

        await clienteRef.set(nuevoCliente);

        if (enviarBienvenida) {
            const apiUrl = `https://${req.headers.host}/api/send-email`;
            fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cliente: { email, nombre, numeroSocio: nuevoNumeroSocio, puntos: nuevoCliente.puntos },
                    tipoPlantilla: 'bienvenida'
                })
            }).catch(err => console.error("Error al disparar email de bienvenida (creación manual):", err));
        }

        return res.status(201).json({ message: 'Cliente creado con éxito.', numeroSocio: nuevoNumeroSocio });

    } catch (error) {
        console.error('Error en API /create-user:', error);
        if (error.code === 'auth/email-already-exists') {
            return res.status(409).json({ error: 'Conflicto: El email ya está registrado en el sistema de autenticación.' });
        }
        return res.status(500).json({ error: 'Error interno del servidor.', details: error.message });
    }
}
