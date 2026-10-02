// Antirrebote del detector de OFFLINE.
//
// El detector original marcaba una maquina offline Y mandaba la alerta en la
// misma pasada, con un unico umbral de 60 s. Como el agente late cada 30 s, un
// micro-corte de red/DNS de ~60-90 s (un par de latidos perdidos) ya disparaba
// correo + push + incidente, aunque la maquina siguiera prendida. En la
// practica genero muchas "caidas" falsas (investigacion del 02/10).
//
// Dos umbrales (configurables por entorno, validados):
//   - MARK_SEG  (rapido): marca is_online=false para el panel y registra la
//     transicion en uptime_log (igual que antes -> el SLA/uptime NO cambia).
//     No alerta.
//   - ALERT_SEG (sostenido): recien aca se avisa y se abre incidente, solo si el
//     silencio se sostuvo. Un blip que se recupera antes NO alerta (al volver el
//     latido, el heartbeat repone is_online=true y offline_notified=false).
//
// Una caida REAL supera ALERT_SEG y alerta igual (con esa gracia de retardo).

function leerSeg(nombre, def) {
  const v = process.env[nombre];
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) { console.warn(`[OFFLINE] ${nombre} invalido ("${v}"), uso ${def}s`); return def; }
  return Math.round(n);
}

let MARK_SEG = leerSeg('OFFLINE_MARK_SEG', 60);
let ALERT_SEG = leerSeg('OFFLINE_ALERT_SEG', 180);
if (ALERT_SEG < MARK_SEG) { console.warn(`[OFFLINE] OFFLINE_ALERT_SEG (${ALERT_SEG}) < OFFLINE_MARK_SEG (${MARK_SEG}); uso ${MARK_SEG}s`); ALERT_SEG = MARK_SEG; }

// Clasifica por la edad del ultimo latido. Puro y testeable. last_heartbeat
// null (nunca latio) -> ni offline ni alerta (igual que el SQL: '<' no matchea NULL).
function clasificar(lastHeartbeat, ahoraMs = Date.now(), opts = {}) {
  const markSeg = opts.markSeg != null ? opts.markSeg : MARK_SEG;
  const alertSeg = opts.alertSeg != null ? opts.alertSeg : ALERT_SEG;
  if (lastHeartbeat == null) return { offline: false, alertar: false, edadSeg: null };
  const t = new Date(lastHeartbeat).getTime();
  if (!Number.isFinite(t)) return { offline: false, alertar: false, edadSeg: null };
  const edadSeg = (ahoraMs - t) / 1000;
  return { offline: edadSeg >= markSeg, alertar: edadSeg >= alertSeg, edadSeg };
}

// Paso 1: marca offline (solo estado) lo que no late hace MARK_SEG. RETURNING
// las que TRANSICIONARON (estaban online) para registrar el uptime.
async function marcarOffline(pool, ahoraMs = Date.now(), markSeg = MARK_SEG) {
  return pool.query(
    `UPDATE machines SET is_online = false
     WHERE is_online = true AND last_heartbeat < $1
     RETURNING id`,
    [new Date(ahoraMs - markSeg * 1000)]
  );
}

// Paso 2 (antirrebote): reclama -de forma atomica- las que sostuvieron el
// silencio >= ALERT_SEG y aun no se avisaron. El propio UPDATE marca
// offline_notified=true y devuelve las filas (reclamo unico, a prueba de
// detectores concurrentes: solo un proceso gana cada fila).
async function reclamarOfflineSostenidas(pool, ahoraMs = Date.now(), alertSeg = ALERT_SEG) {
  return pool.query(
    `UPDATE machines SET offline_notified = true
     WHERE is_online = false AND offline_notified = false AND last_heartbeat < $1
     RETURNING *`,
    [new Date(ahoraMs - alertSeg * 1000)]
  );
}

// Incidente idempotente Y condicionado a que la maquina SIGA offline (guarda
// atomica contra la carrera con un heartbeat que la recupere). No duplica si ya
// hay uno abierto; no crea si ya volvio online.
async function abrirIncidente(pool, machine) {
  const r = await pool.query(
    `INSERT INTO incidents (machine_id, user_id, title, status, started_at)
     SELECT $1, $2, $3, 'open', NOW()
     WHERE EXISTS (SELECT 1 FROM machines WHERE id = $1 AND is_online = false)
       AND NOT EXISTS (SELECT 1 FROM incidents WHERE machine_id = $1 AND status = 'open')
     RETURNING id`,
    [machine.id, machine.user_id, `${machine.machine_name} offline`]
  );
  if (!r.rows.length) return null;
  await pool.query(
    `INSERT INTO incident_events (incident_id, event_type, message) VALUES ($1,'detected',$2)`,
    [r.rows[0].id, `Maquina dejo de responder. Ultima IP: ${machine.public_ip || 'desconocida'}`]
  );
  return r.rows[0].id;
}

// Procesa UNA maquina ya reclamada: abre incidente y avisa. Reconfirma primero
// que siga offline (carrera detector/heartbeat: pudo recuperarse entre el
// reclamo y aca). Si volvio online, no abre incidente ni avisa (el heartbeat ya
// la recupero y resolvio sus incidentes). Si el aviso falla, revierte
// offline_notified para reintentar (no se pierde la alerta); el incidente es
// idempotente y no se duplica en el reintento.
async function procesarSostenida(pool, machine, deps = {}) {
  const log = deps.log || (() => {});
  const enMantenimiento = deps.enMantenimiento || (async () => false);
  const notificar = deps.notificar || (async () => {});

  const act = (await pool.query('SELECT is_online FROM machines WHERE id = $1', [machine.id])).rows[0];
  if (!act || act.is_online) {
    log(`[OFFLINE] ${machine.machine_name} se recupero durante la evaluacion; no se abre incidente ni se avisa`);
    return { omitida: true };
  }
  log(`[OFFLINE] ${machine.machine_name} (${machine.public_ip})`);
  try { await abrirIncidente(pool, machine); } catch (e) { log('incidente: ' + e.message); }
  if (machine.alert_offline === false) return { alertada: false };
  let enMant = false;
  try { enMant = await enMantenimiento(machine.id, machine.user_id); } catch {}
  if (enMant) { log(`[MAINT] Alerta suprimida para ${machine.machine_name} (en ventana de mantenimiento)`); return { alertada: false, mantenimiento: true }; }
  try {
    await notificar(machine);
    return { alertada: true };
  } catch (e) {
    await pool.query('UPDATE machines SET offline_notified = false WHERE id = $1', [machine.id]).catch(() => {});
    log(`[OFFLINE] el aviso de ${machine.machine_name} fallo; se reintentara`);
    return { alertada: false, reintentar: true };
  }
}

// Orquesta el ciclo. deps (inyectables para test, sin notificaciones reales):
//   ahora, log, enMantenimiento(id,userId)->bool, notificar(machine)->Promise
//   (debe RECHAZAR si no se pudo entregar).
async function evaluarOffline(pool, deps = {}) {
  const ahora = deps.ahora != null ? deps.ahora : Date.now();
  const log = deps.log || (() => {});

  // Paso 1: marcar offline + registrar transicion en uptime_log (SLA sin cambios).
  const nuevas = await marcarOffline(pool, ahora);
  for (const m of nuevas.rows) {
    try { await pool.query('INSERT INTO uptime_log (machine_id, status) VALUES ($1, $2)', [m.id, 'offline']); }
    catch (e) { log('uptime_log offline: ' + e.message); }
  }

  // Paso 2: antirrebote -> reclamar sostenidas y procesar cada una.
  const sostenidas = await reclamarOfflineSostenidas(pool, ahora);
  let alertadas = 0;
  for (const machine of sostenidas.rows) {
    const r = await procesarSostenida(pool, machine, deps);
    if (r && r.alertada) alertadas++;
  }
  return { marcadas: nuevas.rows.length, reclamadas: sostenidas.rows.length, alertadas };
}

module.exports = { MARK_SEG, ALERT_SEG, clasificar, marcarOffline, reclamarOfflineSostenidas, abrirIncidente, procesarSostenida, evaluarOffline };
