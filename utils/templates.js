/**
 * /utils/templates.js (ESM)
 * Utilidades de plantillas: lectura unificada + fallback, variables y bloques.
 */

export function sanitizePush(text = "") {
  // Quita saltos y HTML, comprime espacios → ideal para cuerpos de push
  return String(text)
    .replace(/\n|\r/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function applyBlocksAndVars(str, data = {}) {
  let out = String(str || "");

  // Bloques condicionales [BLOQUE_X]...[/BLOQUE_X]
  out = out.replace(/\[(BLOQUE_[A-Z0-9_]+)\]([\s\S]*?)\[\/\1\]/g, (m, tag, inner) => {
    switch (tag) {
      case "BLOQUE_VENCIMIENTO":
        // Mostrar solo si llegó vencimiento
        return (data.puntos_vencen && data.vencimiento_text) ? inner : "";
      case "BLOQUE_PUNTOS_BIENVENIDA":
        // Mostrar si hay puntos_ganados > 0
        return Number(data.puntos_ganados || 0) > 0 ? inner : "";
      case "BLOQUE_CREDENCIALES_PANEL":
        // Mostrar si vienen credenciales/datos de acceso
        return (data.email || data.creado_desde_panel) ? inner : "";
      default:
        return inner;
    }
  });

  // Si alguien dejó suelto el tag de apertura, limpiarlo:
  out = out.replace(/\[BLOQUE_VENCIMIENTO\]/g, "");

  // Reemplazo de {variables}
  out = out.replace(/\{(\w+)\}/g, (m, k) =>
    (data[k] !== undefined && data[k] !== null) ? String(data[k]) : ""
  );

  return out;
}

/**
 * Lee una plantilla priorizando colección unificada `plantillas`,
 * con fallback a `plantillas_push` / `plantillas_mensajes` (legacy).
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} templateId
 * @param {'push'|'email'} channel
 * @returns {Promise<{titulo:string, cuerpo:string}>}
 */
export async function resolveTemplate(db, templateId, channel) {
  // 1) Unificada
  const snap = await db.collection("plantillas").doc(templateId).get();
  if (snap.exists) {
    const d = snap.data() || {};
    const titulo = channel === "push"
      ? (d.titulo_push || d.titulo_email || "Notificación")
      : (d.titulo_email || d.titulo_push || "Notificación");
    const cuerpo = channel === "push"
      ? (d.cuerpo_push || d.cuerpo_email || "")
      : (d.cuerpo_email || d.cuerpo_push || "");
    return { titulo, cuerpo };
  }

  // 2) Legacy (fallback)
  if (channel === "push") {
    const s = await db.collection("plantillas_push").doc(templateId).get();
    if (s.exists) {
      const d = s.data() || {};
      return { titulo: d.titulo_push || "Notificación", cuerpo: d.cuerpo_push || "" };
    }
  } else {
    const s = await db.collection("plantillas_mensajes").doc(templateId).get();
    if (s.exists) {
      const d = s.data() || {};
      return { titulo: d.titulo || "Notificación", cuerpo: d.cuerpo || "" };
    }
  }

  // Fallback final
  return { titulo: "Notificación", cuerpo: "" };
}
