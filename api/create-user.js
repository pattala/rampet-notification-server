revision:// /api/create-user.js (VERSIÓN FINAL CON MANEJO DE OPTIONS)
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
code
Code
download
content_copy
expand_less
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
code
Code
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

// ====================================================================
// == INICIO: BLOQUE CORREGIDO (V2) CON MANEJO DE BONO DE BIENVENIDA ==
// ====================================================================
if (enviarBienvenida) {
    const sendEmailApiUrl = `https://${req.headers.host}/api/send-email`;
    const apiSecretKey = process.env.API_SECRET_KEY;

    // 1. Definimos los datos base para la plantilla.
    const templateData = {
        nombre: nombre.split(' ')[0],
        numero_socio: nuevoNumeroSocio,
    };

    // 2. AÑADIDO: Verificamos si se otorgaron puntos de bienvenida y los añadimos.
    // Usamos el mismo objeto 'nuevoCliente' que ya tiene los puntos calculados.
    if (nuevoCliente.puntos > 0) {
        templateData.puntos_ganados = nuevoCliente.puntos;
    }

    // 3. Construimos el payload final para la API de email.
    const emailPayload = {
        to: email,
        templateId: 'bienvenida', // El ID de la plantilla se mantiene
        templateData: templateData // Ahora contiene los puntos si fueron asignados
    };

    // 4. Realizamos la llamada fetch sin cambios en esta parte.
    fetch(sendEmailApiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiSecretKey}`
        },
        body: JSON.stringify(emailPayload)
    })
    .then(response => {
        if (!response.ok) {
            response.json().then(err => {
                 console.error(`Error al llamar a send-email API: ${response.status}`, err);
            });
        } else {
             console.log("Llamada a send-email API para bienvenida realizada con éxito.");
        }
    })
    .catch(err => {
        console.error("Error de red al intentar disparar el email de bienvenida:", err);
    });
}
// ====================================================================
// == FIN: BLOQUE CORREGIDO (V2)                                     ==
// ====================================================================
