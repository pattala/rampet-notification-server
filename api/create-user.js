// /api/create-user.js (VERSIÓN FINAL, COMPLETA Y SEGURA)
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
    const regla = [...reglasCaducidad]
        .sort((a, b) => b.minPuntos - a.minPuntos)
        .find(r => puntos >= r.minPuntos);
    if (!regla && reglasCaducidad.length > 0) {
        return [...reglasCaducidad].sort((a,b) => a.minPuntos - b.minPuntos)[0].cadaDias;
    }
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

        // 2. Extracción y validación de datos
        const { dni, nombre, email, telefono, fechaNacimiento, fechaInscripcion, enviarBienvenida, bonoBienvenida } = req.body;
        if (!dni || !nombre || !email) {
            return res.status(400).json({ error: 'DNI, Nombre y Email son obligatorios.' });
        }

        // =================================================================
        // == INICIO: CAPA DE SEGURIDAD CONTRA DUPLICADOS                 ==
        // =================================================================
        // Verificamos si ya existe un cliente en Firestore con ese email o DNI.
        const emailQuery = await db.collection('clientes').where('email', '==', email).limit(1).get();
        if (!emailQuery.empty) {
            return res.status(409).json({ error: `Conflicto: El email '${email}' ya está en uso por otro cliente.` });
        }
        const dniQuery = await db.collection('clientes').where('dni', '==', dni).limit(1).get();
        if (!dniQuery.empty) {
            return res.status(409).json({ error: `Conflicto: El DNI '${dni}' ya está en uso por otro cliente.` });
        }
        // =================================================================
        // == FIN: CAPA DE SEGURIDAD                                      ==
        // =================================================================

        // 3. Creación del usuario en Firebase Authentication
        const userRecord = await admin.auth().createUser({
            email: email,
            password: dni, // Usamos el DNI como contraseña inicial
            displayName: nombre,
        });
        const authUID = userRecord.uid;

        // 4. Lógica de asignación de Número de Socio (usando transacción)
        const contadorRef = db.collection("configuracion").doc("contadores");
        const clienteRef = db.collection('clientes').doc(); // Generamos un ID para el nuevo documento
        
        const nuevoNumeroSocio = await db.runTransaction(async (transaction) => {
            const contadorDoc = await transaction.get(contadorRef);
            let numero = 1;
            if (contadorDoc.exists && contadorDoc.data().ultimoNumeroSocio) {
                numero = contadorDoc.data().ultimoNumeroSocio + 1;
            }
            transaction.set(contadorRef, { ultimoNumeroSocio: numero }, { merge: true });
            return numero;
        });

        // 5. Preparación del documento del cliente
        const nuevoCliente = {
            id: clienteRef.id,
            numeroSocio: nuevoNumeroSocio,
            authUID: authUID,
            dni, nombre, email, telefono, fechaNacimiento, fechaInscripcion,
            puntos: 0, saldoAcumulado: 0, totalGastado: 0, ultimaCompra: "",
            historialPuntos: [], historialCanjes: [], fcmTokens: [],
            terminosAceptados: true, 
            passwordPersonalizada: false, // Creado por admin, contraseña es DNI
        };
        
        // 6. Lógica de Bono de Bienvenida (si aplica)
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

        // 7. Guardar el nuevo cliente en Firestore
        await clienteRef.set(nuevoCliente);

        // 8. Enviar email de bienvenida (si aplica)
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
        // Manejo de errores comunes
        if (error.code === 'auth/email-already-exists') {
            return res.status(409).json({ error: 'Conflicto: El email ya está registrado en el sistema de autenticación.' });
        }
        return res.status(500).json({ error: 'Error interno del servidor.', details: error.message });
    }
}
