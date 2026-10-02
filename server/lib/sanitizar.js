// Quita U+0000 (byte nulo) de strings, recursivamente en objetos y arrays.
//
// Por que: PostgreSQL no admite U+0000 en columnas text ni jsonb. Un solo byte
// nulo en CUALQUIER campo del heartbeat (p. ej. agent_logs, os_info o el nombre
// de un servicio) hacia fallar TODO el INSERT/UPDATE con
//   invalid byte sequence for encoding "UTF8": 0x00
// y el servidor devolvia "Error interno". La maquina quedaba 'muda' ante el
// server (su last_heartbeat no avanzaba) y eso disparaba falsas caidas.
//
// Se limpia SOLO el byte nulo, dentro de strings (y claves de objeto, que en
// jsonb tambien romperian). Preserva tipos (numeros, booleanos, null) y todo
// Unicode valido (acentos, emojis). NO se aplica sobre JSON ya serializado ni
// sobre campos de autenticacion: el llamador elige que campos pasar (ver el
// ingest del heartbeat), nunca machine_key/firmas.
//
// Claves de objeto (caso de borde pedido): al quitar el nulo, dos claves pueden
// colapsar a la misma. Para NO perder datos en silencio por sobrescritura, se
// conserva la PRIMERA ocurrencia (precedencia determinista) y se avisa por log
// SIN registrar el contenido. Ademas se usa Object.defineProperty (no asignacion
// con '='), asi una clave como "__proto__" queda como propiedad propia y no
// contamina Object.prototype ni dispara su setter.

const RE_NUL = new RegExp(String.fromCharCode(0), 'g'); // U+0000

function quitarNulos(x) {
  if (typeof x === 'string') return x.replace(RE_NUL, '');
  if (Array.isArray(x)) return x.map(quitarNulos);
  if (x && typeof x === 'object') {
    const out = {};
    for (const kRaw of Object.keys(x)) {
      const k = kRaw.replace(RE_NUL, '');
      const v = quitarNulos(x[kRaw]);
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        // Colision tras limpiar el nulo: no se pisa en silencio; gana la primera.
        console.warn('[sanitizar] colision de clave tras quitar U+0000; se conserva la primera ocurrencia');
        continue;
      }
      Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true });
    }
    return out;
  }
  return x; // number, boolean, null, undefined: sin cambios
}

module.exports = { quitarNulos };
