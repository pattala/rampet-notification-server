// api/create-user.js (Versión Final ESM)

import admin from 'firebase-admin';

// --- Helpers ---
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

// --- Handler Principal ---
export default async function handler(req, res) {
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

        // (El resto de la lógica de negocio se mantiene igual...)
        const emailQuery = await db.collection('clientes').where('email', '==', email).limit(1).get();
        if (!emailQuery.empty) return res.status(409).json({ error: `Conflicto: El email '${email}' ya está en uso.` });

        const dniQuery = await db.collection('clientes').where('dni', '==', dni).limit(1).get();
        if (!dniQuery.empty) return res.status(409).json({ error: `Conflicto: El DNI '${dni}' ya está en uso.` });

        const userRecord = await admin.auth().createUser({ email: email, password: dni, displayName: nombre });
        
        const contadorRef = db.collection("configuracion").doc("contadores");
        const clienteRef = db.collection('clientes').doc(userRecord.uid); // Usamos el UID de Auth como ID de documento
        const nuevoNumeroSocio = await db.runTransaction(async (t) => {
            const doc = await t.get(contadorRef);
            const nuevoNum = (doc.data()?.ultimoNumeroSocio || 0) + 1;
            t.set(contadorRef, { ultimoNumeroSocio: nuevoNum }, { merge: true });
            return nuevoNum;
        });

        const nuevoCliente = {
            id: clienteRef.id, numeroSocio: nuevoNumeroSocio, authUID: userRecord.uid,
            dni, nombre, email, telefono, fechaNacimiento, fechaInscripcion,
            puntos: 0, saldoAcumulado: 0, totalGastado: 0, ultimaCompra: "",
            historialPuntos: [], historialCanjes: [], fcmTokens: [],
            terminosAceptados: true, passwordPersonalizada: false,
        };

        if (bonoBienvenida.activo && bonoBienvenida.puntos > 0) {
            nuevoCliente.puntos += bonoBienvenida.puntos;
            nuevoCliente.historialPuntos.push({
                fechaObtencion: new Date().toISOString(),
                puntosObtenidos: bonoBienvenida.puntos,
                puntosDisponibles: bonoBienvenida.puntos,
                origen: 'Bono de Bienvenida',
                diasCaducidad: getDiasCaducidad(bonoBienvenida.puntos, [])
            });
        }

        await clienteRef.set(nuevoCliente);

        let emailEnviado = false;
        if (enviarBienvenida) {
            try {
                const response = await fetch(`https://${req.headers.host}/api/send-email`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.API_SECRET_KEY}` },
                    body: JSON.stringify({
                        to: email,
                        templateId: 'bienvenida',
                        templateData: {
                            nombre: nombre.split(' ')[0],
                            numero_socio: nuevoNumeroSocio,
                            puntos_ganados: nuevoCliente.puntos,
                            creado_desde_panel: true
                        }
                    })
                });
                if (response.ok) emailEnviado = true;
            } catch (e) { console.error("Fallo en fetch a send-email:", e); }
        }

        return res.status(201).json({
            message: 'Cliente creado con éxito.',
            numeroSocio: nuevoNumeroSocio,
            emailEnviado: emailEnviado
        });

    } catch (error) {
        console.error('Error en API /create-user:', error);
        if (error.code === 'auth/email-already-exists') {
            return res.status(409).json({ error: 'El email ya está registrado en autenticación.' });
        }
        return res.status(500).json({ error: 'Error interno del servidor.', details: error.message });
    }
}
