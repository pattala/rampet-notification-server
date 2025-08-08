// /api/assign-socio-number.js (VERSIÓN CON ENVÍO DE EMAIL)
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
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).send('');
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const { docId } = req.body;
  if (!docId) {
    return res.status(400).json({ error: 'Falta el ID del documento del cliente.' });
  }

  try {
    const contadorRef = db.collection("configuracion").doc("contadores");
    const clienteRef = db.collection("clientes").doc(docId);
    
    // --- INICIO: NUEVA LÓGICA DE EMAIL ---
    let datosClienteParaEmail = null; 
    // --- FIN: NUEVA LÓGICA DE EMAIL ---

    await db.runTransaction(async (transaction) => {
      const contadorDoc = await transaction.get(contadorRef);
      const clienteDoc = await transaction.get(clienteRef);

      if (!clienteDoc.exists) {
        throw new Error("El documento del cliente no existe.");
      }
      
      const clienteData = clienteDoc.data();

      // Guardamos los datos del cliente para usarlos después de la transacción
      datosClienteParaEmail = {
          nombre: clienteData.nombre,
          email: clienteData.email,
          puntos: clienteData.puntos
      };

      if (clienteData.numeroSocio) {
        console.log(`El cliente ${docId} ya tenía N° de Socio. No se hace nada.`);
        return;
      }

      let nuevoNumeroSocio = 1;
      if (contadorDoc.exists && contadorDoc.data().ultimoNumeroSocio) {
        nuevoNumeroSocio = contadorDoc.data().ultimoNumeroSocio + 1;
      }

      transaction.set(contadorRef, { ultimoNumeroSocio: nuevoNumeroSocio }, { merge: true });
      transaction.update(clienteRef, { numeroSocio: nuevoNumeroSocio });

      // Actualizamos el objeto que usaremos para el email con el número de socio recién asignado
      datosClienteParaEmail.numeroSocio = nuevoNumeroSocio;

      console.log(`Asignado N° de Socio ${nuevoNumeroSocio} al cliente con docId: ${docId}`);
    });

    // --- INICIO: LLAMADA A LA API DE ENVÍO DE EMAIL ---
    // Después de que la transacción ha sido exitosa, enviamos el email.
    if (datosClienteParaEmail) {
        // Obtenemos la URL absoluta de nuestra propia API
        const apiUrl = `https://${req.headers.host}/api/send-email`;
        
        // Disparamos la llamada y no esperamos a que termine (fire-and-forget)
        fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cliente: datosClienteParaEmail,
                tipoPlantilla: 'bienvenida'
            })
        }).catch(err => console.error("Error al disparar el envío de email:", err));
    }
    // --- FIN: LLAMADA A LA API DE ENVÍO DE EMAIL ---

    return res.status(200).json({ message: 'Número de socio asignado y email de bienvenida encolado.' });

  } catch (error) {
    console.error('Error asignando número de socio:', error);
    return res.status(500).json({ error: 'Error interno del servidor.', details: error.message });
  }
}
