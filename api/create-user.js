// api/create-user.js (Versión Final Híbrida)

const admin = require('firebase-admin');

function initializeFirebaseAdmin() {
    if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
    }
    return admin.firestore();
}

function getDiasCaducidad(puntos, reglasCaducidad) {
    if (!reglasCaducidad || reglasCaducidad.length === 0) return 90;
    const regla = [...reglasCaducidad].sort((a, b) => b.minPuntos - a.minPuntos).find(r => puntos >= r.minPuntos);
    if (!regla && reglasCaducidad.length > 0) return [...reglasCaducidad].sort((a, b) => a.minPuntos - b.minPuntos)[0].cadaDias;
    return regla ? regla.cadaDias : 90;
}

export default async function handler(req, res) {
    // RE-INTRODUCIDO: Manejo explícito de OPTIONS para un cortocircuito seguro.
    // vercel.json se encargará de añadir las cabeceras CORS correctas.
    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

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
            const puntosBono = bonoBienvenida.puntos;
            nuevoCliente.puntos += puntosBono;
            nuevoCliente.historialPuntos.push({
                fechaObtencion: new Date().toISOString(),
                puntosObtenidos: puntosBono,
                puntosDisponibles: puntosBono,
                origen: 'Bono de Bienvenida',
                diasCaducidad: getDiasCaducidad(puntosBono, [])
            });
        }

        await clienteRef.set(nuevoCliente);

        if (enviarBienvenida) {
            const sendEmailApiUrl = `https://${req.headers.host}/api/send-email`;
            const apiSecretKey = process.env.API_SECRET_KEY;

            const templateData = {
                nombre: nombre.split(' ')[0],
                numero_socio: nuevoNumeroSocio,
            };

            if (nuevoCliente.puntos > 0) {
                templateData.puntos_ganados = nuevoCliente.puntos;
            }

            const emailPayload = {
                to: email,
                templateId: 'bienvenida',
                templateData: templateData
            };

            fetch(sendEmailApiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiSecretKey}`
                },
                body: JSON.stringify(emailPayload)
            }).catch(err => console.error("Error asíncrono en fetch a send-email:", err));
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
