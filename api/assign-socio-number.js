// /api/assign-socio-number.js
const admin = require('firebase-admin');

// Inicializa la app de Firebase Admin si no lo ha hecho ya
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  // 1. Permitir peticiones pre-vuelo (CORS) y verificar el método
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).send('');
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  // 2. Obtener el ID del documento del cuerpo de la petición
  const { docId } = req.body;
  if (!docId) {
    return res.status(400).json({ error: 'Falta el ID del documento del cliente.' });
  }

  try {
    // 3. Referencias a los documentos en Firestore
    const contadorRef = db.collection("configuracion").doc("contadores");
    const clienteRef = db.collection("clientes").doc(docId);

    // 4. Ejecutar una transacción para garantizar la atomicidad
    await db.runTransaction(async (transaction) => {
      const contadorDoc = await transaction.get(contadorRef);
      const clienteDoc = await transaction.get(clienteRef);

      if (!clienteDoc.exists) {
        throw new Error("El documento del cliente no existe.");
      }
      // Verificamos si ya tiene número para evitar re-asignaciones
      if (clienteDoc.data().numeroSocio) {
        console.log(`El cliente ${docId} ya tenía N° de Socio. No se hace nada.`);
        return;
      }

      let nuevoNumeroSocio = 1; // Valor por defecto si el contador no existe
      if (contadorDoc.exists && contadorDoc.data().ultimoNumeroSocio) {
        nuevoNumeroSocio = contadorDoc.data().ultimoNumeroSocio + 1;
      }

      // 5. Actualizar ambos documentos dentro de la transacción
      transaction.set(contadorRef, { ultimoNumeroSocio: nuevoNumeroSocio }, { merge: true });
      transaction.update(clienteRef, { numeroSocio: nuevoNumeroSocio });

      console.log(`Asignado N° de Socio ${nuevoNumeroSocio} al cliente con docId: ${docId}`);
    });

    return res.status(200).json({ message: 'Número de socio asignado con éxito.' });
  } catch (error) {
    console.error('Error asignando número de socio:', error);
    return res.status(500).json({ error: 'Error interno del servidor.', details: error.message });
  }
}
