'use strict';
//
// Incidentes y avisos de los monitores de URL.
//
// NO es un sistema paralelo: reutiliza la tabla `incidents`/`incident_events`
// (la misma de las maquinas; `incidents.url_id` ata el incidente al monitor) y
// el envio de avisos (sendPush/avisarAExtras, inyectado como `notificar`).
// Mismo patron que lib/offline.js:
//   - incidente IDEMPOTENTE: un solo incidente abierto por caida confirmada
//     (INSERT ... SELECT WHERE sigue caido AND NOT EXISTS uno abierto);
//   - reclamo ATOMICO del aviso (UPDATE ... WHERE alert_pendiente=$t RETURNING):
//     con varios workers, solo uno gana y entrega cada aviso;
//   - reintento de ENTREGA: si el aviso falla, se revierte el flag y se reintenta
//     en la proxima pasada, sin generar avisos repetidos.
//
// Pausar o editar un monitor NO pasa por aca: no se interpreta como recuperacion.

// Abre un incidente para el monitor si sigue caido y no hay uno abierto. Devuelve
// el id del incidente nuevo, o null si ya habia uno o ya se recupero.
async function abrirIncidenteUrl(pool, mon) {
  const r = await pool.query(
    `INSERT INTO incidents (url_id, user_id, title, status, started_at)
     SELECT $1, $2, $3, 'open', NOW()
     WHERE EXISTS (SELECT 1 FROM url_monitors WHERE id = $1 AND is_up = false)
       AND NOT EXISTS (SELECT 1 FROM incidents WHERE url_id = $1 AND status = 'open')
     RETURNING id`,
    [mon.id, mon.user_id, `${mon.name || mon.url} caido`]
  );
  if (!r.rows.length) return null;
  await pool.query(
    `INSERT INTO incident_events (incident_id, event_type, message) VALUES ($1,'detected',$2)`,
    [r.rows[0].id, `${mon.name || mon.url} no responde: ${mon.last_error || 's/d'}`]
  ).catch(() => {});
  return r.rows[0].id;
}

// Resuelve el/los incidente(s) abierto(s) del monitor. Devuelve cuantos cerro.
async function resolverIncidenteUrl(pool, mon) {
  const r = await pool.query(
    `UPDATE incidents SET status='resolved', ended_at=NOW(),
       duration_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW()-started_at))/60.0))
     WHERE url_id=$1 AND status='open' RETURNING id`,
    [mon.id]
  );
  for (const row of r.rows) {
    await pool.query(
      `INSERT INTO incident_events (incident_id, event_type, message) VALUES ($1,'resolved',$2)`,
      [row.id, `${mon.name || mon.url} volvio a responder`]
    ).catch(() => {});
  }
  return r.rows.length;
}

// Aplica la transicion de estado de UN monitor ya chequeado:
//  - cae (wasUp=true -> isUp=false): abre incidente idempotente y deja un aviso
//    'down' pendiente de entrega (si notify_down).
//  - recupera (false -> true): resuelve el incidente. Solo deja aviso 'up' si la
//    caida llego a anunciarse; si el aviso 'down' seguia pendiente (nunca se
//    entrego), se cancela y NO se anuncia recuperacion.
// Nada de esto corre al pausar/editar (eso no llama a checkUrlMonitor).
async function aplicarTransicionUrl(pool, mon, isUp, wasUp) {
  if (wasUp === isUp) return { cambio: false };
  if (!isUp) {
    await abrirIncidenteUrl(pool, mon);
    if (mon.notify_down) {
      await pool.query(`UPDATE url_monitors SET alert_pendiente='down' WHERE id=$1`, [mon.id]);
    }
    return { cambio: true, tipo: 'down' };
  }
  const cerrados = await resolverIncidenteUrl(pool, mon);
  const pend = (await pool.query(`SELECT alert_pendiente FROM url_monitors WHERE id=$1`, [mon.id])).rows[0];
  if (pend && pend.alert_pendiente === 'down') {
    // la caida no se habia entregado: no anunciamos recuperacion de algo no avisado
    await pool.query(`UPDATE url_monitors SET alert_pendiente=NULL WHERE id=$1 AND alert_pendiente='down'`, [mon.id]);
    return { cambio: true, tipo: 'up', suprimido: true };
  }
  if (cerrados > 0 && mon.notify_down) {
    await pool.query(`UPDATE url_monitors SET alert_pendiente='up' WHERE id=$1`, [mon.id]);
  }
  return { cambio: true, tipo: 'up', cerrados };
}

// Entrega los avisos pendientes. `notificar(mon, tipo)` debe RECHAZAR si no se
// pudo entregar (igual que en offline.js). Reclamo atomico por aviso: con varios
// workers solo uno entrega; si falla, se revierte y se reintenta despues.
async function entregarAvisosUrl(pool, deps = {}) {
  const notificar = deps.notificar || (async () => {});
  const log = deps.log || (() => {});
  const pend = await pool.query(`SELECT * FROM url_monitors WHERE alert_pendiente IS NOT NULL`);
  let entregados = 0;
  for (const mon of pend.rows) {
    const tipo = mon.alert_pendiente;
    const claim = await pool.query(
      `UPDATE url_monitors SET alert_pendiente=NULL WHERE id=$1 AND alert_pendiente=$2 RETURNING id`,
      [mon.id, tipo]
    );
    if (!claim.rows.length) continue; // otro worker lo tomo
    try {
      await notificar(mon, tipo);
      entregados++;
    } catch (e) {
      await pool.query(`UPDATE url_monitors SET alert_pendiente=$2 WHERE id=$1 AND alert_pendiente IS NULL`, [mon.id, tipo]).catch(() => {});
      log(`[URL-AVISO] entrega fallo para ${mon.url} (${tipo}); se reintentara`);
    }
  }
  return { entregados };
}

module.exports = { abrirIncidenteUrl, resolverIncidenteUrl, aplicarTransicionUrl, entregarAvisosUrl };
