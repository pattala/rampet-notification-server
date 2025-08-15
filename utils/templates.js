/**
 * /utils/templates.js (ESM)
 * Utilidades compartidas para plantillas (push + email).
 */

export function sanitizePush(text = "") {
  // Quita saltos, etiquetas HTML y comprime espacios (ideal para push)
  return String(text)
    .replace(/\n|\r/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function applyBlocksAndVars(str, data = {}) {
  let out = String(str || "");

  // Bloques condicionales [BLOQUE_...][/BLOQUE_...]
  out = out.replace(/\[(BLOQUE_[A-Z0-9_]+)\]([\s\S]*?)\[\/\1\]/g, (_m, tag, inner) => {
    switch (tag) {
      case "BLOQUE_VENCIMIENTO":
        return (data.puntos_vencen && data.vencimiento_text) ? inner : "";
      case "BLOQUE_PUNTOS_BIENVENIDA":
        return Number(data.puntos_ganados || 0) > 0 ? inner : "";
      case "BLOQUE_CREDENCIALES_PANEL":
        return (data.email || data.creado_desde_panel) ? inner : "";
      case "BLOQUE_MENSAJE_PERSONAL":
        return (data.mensaje_opcional && String(data.mensaje_opcional).trim()) ? inner : "";
      default:
        return inner;
    }
  });

  // Si quedó tag suelto
  out = out.replace(/\[BLOQUE_VENCIMIENTO\]/g, "");

  // Reemplazo de {variables}
  out = out.replace(/\{(\w+)\}/g, (m, k) =>
    (data[k] !== undefined && data[k] !== null) ? String(data[k]) : ""
  );

  return out;
}

/**
 * Lee una plantilla priorizando colección unificada `plantillas`
 * con fallback a colecciones legacy.
 *
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} templateId
 * @param {'push'|'email'} channel
 * @returns {Promise<{titulo: string, cuerpo: string}>}
 */
export async function resolveTemplate(db, templateId, channel) {
  // 1) Unificada
  const snap = await db.collection("plantillas").doc(templateId).get();
  if (snap.exists) {
    const d = snap.data() || {};
    const titulo = channel === "push"
      ? (d.titulo_push ?? d.titulo_email ?? "Notificación")
      : (d.titulo_email ?? d.titulo_push ?? "Notificación");
    const cuerpo = channel === "push"
      ? (d.cuerpo_push ?? d.cuerpo_email ?? "")
      : (d.cuerpo_email ?? d.cuerpo_push ?? "");
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

  return { titulo: "Notificación", cuerpo: "" };
}
