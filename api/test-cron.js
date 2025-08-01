// Archivo: api/test-cron.js

export default function handler(req, res) {
  console.log("¡El Cron de prueba se ha ejecutado!");
  res.status(200).send("Cron de prueba ejecutado con éxito.");
}```

**Paso 2: Modificar `vercel.json` para que apunte a la API de prueba**

Ahora, vamos a decirle a Vercel que ejecute **esta nueva y simple función**, no la nuestra. Cambiaremos el `path` y la `schedule` para que se ejecute cada minuto y podamos ver el resultado rápidamente.

Reemplaza el contenido de tu `vercel.json` con esto:
```json
{
  "crons": [
    {
      "path": "/api/test-cron",
      "schedule": "* * * * *"
    }
  ]
}
