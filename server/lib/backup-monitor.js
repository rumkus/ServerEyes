'use strict';
//
// Monitor de BACKUPS (recepcion de recibos del exportador offsite de Linde).
//
// No es un monitor HTTP (url_monitors): aca ServerEyes NO sondea, RECIBE eventos
// HTTPS autenticados del exportador (push). Reutiliza la tabla `incidents`
// (incidents.backup_monitor_id) y el envio de avisos (sendPush/avisarAExtras,
// inyectado como `notificar`), con el mismo patron de reintento de entrega.
//
// Estados: pendiente (sin copia valida; NUNCA saludable por defecto) / saludable
// (ultima captura verificada dentro de la frescura) / vencido (frescura superada)
// / fallo (evento de ejecucion fallida sin exito posterior).
//
// Frescura: se alerta cuando pasan > FRESHNESS_SEGUNDOS desde `capturedAt` de la
// ultima copia con descarga verificada. Todo el calculo en UTC (TIMESTAMPTZ).

const crypto = require('crypto');

const FRESHNESS_SEGUNDOS = 26 * 3600;      // 26 h
const FUTURO_TOLERANCIA_SEG = 300;         // 5 min de tolerancia para timestamps futuros
const SHA256_RE = /^[a-f0-9]{64}$/i;

// --- credencial del monitor (token exclusivo) ---
function generarToken() { return crypto.randomBytes(32).toString('hex'); }
function hashToken(token) { return crypto.createHash('sha256').update(String(token || '')); }
function hashTokenHex(token) { return hashToken(token).digest('hex'); }
function tokenCoincide(token, tokenHashHex) {
  if (!token || !tokenHashHex) return false;
  const a = Buffer.from(hashTokenHex(token), 'hex');
  const b = Buffer.from(String(tokenHashHex), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- validacion de eventos (pura) ---
// ev: cuerpo recibido. monitor: fila backup_monitors. now: Date.
// Devuelve { ok, motivo, datos } para 'offsite_backup_verified'.
function validarVerified(ev, monitor, now = new Date()) {
  if (!ev || typeof ev !== 'object') return { ok: false, motivo: 'cuerpo invalido' };
  if (ev.event !== 'offsite_backup_verified') return { ok: false, motivo: `event inesperado: ${ev.event}` };
  if (ev.downloadVerified !== true) return { ok: false, motivo: 'downloadVerified debe ser true (subir sin comprobar no es exito)' };
  if (ev.environment && monitor.environment && ev.environment !== monitor.environment) {
    return { ok: false, motivo: `ambiente no coincide (${ev.environment} != ${monitor.environment})` };
  }
  if (!ev.backupId || typeof ev.backupId !== 'string') return { ok: false, motivo: 'backupId requerido' };
  const bytes = Number(ev.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, motivo: 'bytes debe ser positivo' };
  if (!SHA256_RE.test(ev.sha256 || '')) return { ok: false, motivo: 'sha256 invalido (64 hex)' };
  const captured = Date.parse(ev.capturedAt);
  if (!Number.isFinite(captured)) return { ok: false, motivo: 'capturedAt invalido' };
  if (captured > now.getTime() + FUTURO_TOLERANCIA_SEG * 1000) {
    return { ok: false, motivo: 'capturedAt en el futuro (fuera de tolerancia de 5 min)' };
  }
  // `id` = id privado del archivo en Drive -> lo normalizamos a fileId.
  const fileId = ev.id || ev.fileId || null;
  const verifiedAt = ev.verifiedAt && Number.isFinite(Date.parse(ev.verifiedAt)) ? ev.verifiedAt : null;
  return { ok: true, datos: {
    backupId: ev.backupId, capturedAt: new Date(captured).toISOString(),
    bytes, sha256: String(ev.sha256).toLowerCase(), fileId, verifiedAt
  } };
}

// Evento de ejecucion fallida (contrato NUEVO definido por ServerEyes).
function validarFailed(ev, monitor, now = new Date()) {
  if (!ev || typeof ev !== 'object') return { ok: false, motivo: 'cuerpo invalido' };
  if (ev.event !== 'offsite_backup_failed') return { ok: false, motivo: `event inesperado: ${ev.event}` };
  if (ev.environment && monitor.environment && ev.environment !== monitor.environment) {
    return { ok: false, motivo: 'ambiente no coincide' };
  }
  if (!ev.runId && !ev.backupId) return { ok: false, motivo: 'runId o backupId requerido' };
  let failedAt = ev.failedAt ? Date.parse(ev.failedAt) : now.getTime();
  if (!Number.isFinite(failedAt)) failedAt = now.getTime();
  if (failedAt > now.getTime() + FUTURO_TOLERANCIA_SEG * 1000) return { ok: false, motivo: 'failedAt en el futuro' };
  // Causa saneada: recortamos y sacamos saltos de linea.
  const reason = String(ev.reason || 'sin causa informada').replace(/\s+/g, ' ').slice(0, 300);
  return { ok: true, datos: {
    runId: ev.runId || null, backupId: ev.backupId || null,
    failedAt: new Date(failedAt).toISOString(), reason
  } };
}

// Estado por frescura (puro). monitor.last_success_captured_at = TIMESTAMPTZ|null.
function estadoFrescura(monitor, now = new Date()) {
  if (!monitor || monitor.last_success_captured_at == null) return 'pendiente';
  const cap = new Date(monitor.last_success_captured_at).getTime();
  if (!Number.isFinite(cap)) return 'pendiente';
  const fresh = (monitor.freshness_seconds || FRESHNESS_SEGUNDOS) * 1000;
  return (now.getTime() - cap) > fresh ? 'vencido' : 'saludable';
}
function segundosDesdeCaptura(monitor, now = new Date()) {
  if (!monitor || monitor.last_success_captured_at == null) return null;
  const cap = new Date(monitor.last_success_captured_at).getTime();
  if (!Number.isFinite(cap)) return null;
  return Math.round((now.getTime() - cap) / 1000);
}

// --- incidentes (reusa incidents, incidents.backup_monitor_id) ---
async function abrirIncidenteBackup(pool, monitor, titulo, detalle) {
  const r = await pool.query(
    `INSERT INTO incidents (backup_monitor_id, user_id, title, status, started_at)
     SELECT $1, $2, $3, 'open', NOW()
     WHERE NOT EXISTS (SELECT 1 FROM incidents WHERE backup_monitor_id = $1 AND status = 'open')
     RETURNING id`,
    [monitor.id, monitor.user_id, titulo]
  );
  if (!r.rows.length) return null;
  await pool.query(`INSERT INTO incident_events (incident_id, event_type, message) VALUES ($1,'detected',$2)`,
    [r.rows[0].id, detalle || titulo]).catch(() => {});
  return r.rows[0].id;
}
async function resolverIncidenteBackup(pool, monitor, detalle) {
  const r = await pool.query(
    `UPDATE incidents SET status='resolved', ended_at=NOW(),
       duration_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW()-started_at))/60.0))
     WHERE backup_monitor_id=$1 AND status='open' RETURNING id`,
    [monitor.id]
  );
  for (const row of r.rows) {
    await pool.query(`INSERT INTO incident_events (incident_id, event_type, message) VALUES ($1,'resolved',$2)`,
      [row.id, detalle || 'Backup recuperado']).catch(() => {});
  }
  return r.rows.length;
}

// Ingesta de un recibo verificado (ya validado). Dedup por backupId, orden por
// capturedAt (no reemplaza una captura mas nueva), recuperacion solo con captura
// RECIENTE. Devuelve { resultado: aplicado|duplicado|conflicto|viejo, ... }.
async function ingestarVerified(pool, monitor, datos, now = new Date()) {
  const dedupKey = datos.backupId;
  const ins = await pool.query(
    `INSERT INTO backup_events (monitor_id, tipo, dedup_key, backup_id, captured_at, received_at, bytes, sha256, file_id, verified_at, aceptado)
     VALUES ($1,'verified',$2,$3,$4,NOW(),$5,$6,$7,$8,true)
     ON CONFLICT (monitor_id, dedup_key) DO NOTHING RETURNING id`,
    [monitor.id, dedupKey, datos.backupId, datos.capturedAt, datos.bytes, datos.sha256, datos.fileId, datos.verifiedAt]
  );
  if (!ins.rows.length) {
    const prev = (await pool.query(`SELECT bytes, sha256 FROM backup_events WHERE monitor_id=$1 AND dedup_key=$2`, [monitor.id, dedupKey])).rows[0];
    if (prev && (String(prev.sha256) !== datos.sha256 || Number(prev.bytes) !== datos.bytes)) return { resultado: 'conflicto' };
    return { resultado: 'duplicado' };
  }
  const freshMs = (monitor.freshness_seconds || FRESHNESS_SEGUNDOS) * 1000;
  const reciente = (now.getTime() - Date.parse(datos.capturedAt)) <= freshMs;
  const estadoNuevo = reciente ? 'saludable' : 'vencido';
  const upd = await pool.query(
    `UPDATE backup_monitors SET
       last_success_backup_id=$2, last_success_captured_at=$3, last_success_received_at=NOW(),
       last_success_bytes=$4, last_success_sha256=$5, last_success_file_id=$6, last_success_verified_at=$7,
       estado=$8
     WHERE id=$1 AND (last_success_captured_at IS NULL OR last_success_captured_at < $3::timestamptz)
     RETURNING id`,
    [monitor.id, datos.backupId, datos.capturedAt, datos.bytes, datos.sha256, datos.fileId, datos.verifiedAt, estadoNuevo]
  );
  const renovo = upd.rows.length > 0;
  if (renovo && reciente) {
    const cerrados = await resolverIncidenteBackup(pool, monitor, `Backup verificado reciente (backupId ${datos.backupId})`);
    if (cerrados > 0) await pool.query(`UPDATE backup_monitors SET alert_pendiente='recuperado' WHERE id=$1`, [monitor.id]);
  }
  return { resultado: renovo ? 'aplicado' : 'viejo', reciente, estado: estadoNuevo };
}

// Ingesta de un evento de fallo. Abre incidente salvo que ya haya una captura
// exitosa POSTERIOR al fallo (fallo viejo no reabre un incidente recuperado).
async function ingestarFailed(pool, monitor, datos, now = new Date()) {
  const dedupKey = datos.runId || datos.backupId;
  const ins = await pool.query(
    `INSERT INTO backup_events (monitor_id, tipo, dedup_key, backup_id, run_id, received_at, reason, aceptado)
     VALUES ($1,'failed',$2,$3,$4,NOW(),$5,true)
     ON CONFLICT (monitor_id, dedup_key) DO NOTHING RETURNING id`,
    [monitor.id, dedupKey, datos.backupId, datos.runId, datos.reason]
  );
  if (!ins.rows.length) return { resultado: 'duplicado' };
  await pool.query(`UPDATE backup_monitors SET last_attempt_at=NOW(), last_failure_at=$2, last_failure_reason=$3, last_failure_run_id=$4 WHERE id=$1`,
    [monitor.id, datos.failedAt, datos.reason, datos.runId]);
  const superado = monitor.last_success_captured_at && Date.parse(monitor.last_success_captured_at) >= Date.parse(datos.failedAt);
  if (superado) return { resultado: 'superado' };
  await pool.query(`UPDATE backup_monitors SET estado='fallo' WHERE id=$1`, [monitor.id]);
  const incId = await abrirIncidenteBackup(pool, monitor, `Backup fallido: ${monitor.name}`,
    `Ejecucion fallida (run ${datos.runId || 's/d'}): ${datos.reason}`);
  if (incId) await pool.query(`UPDATE backup_monitors SET alert_pendiente='fallo' WHERE id=$1`, [monitor.id]);
  return { resultado: 'aplicado', incidente: incId };
}

// Scheduler de frescura: por cada monitor activo, si la ultima captura verificada
// supera la frescura -> incidente de vencido (uno solo) + aviso pendiente.
async function evaluarFrescuraBackups(pool, now = new Date()) {
  const mons = await pool.query(`SELECT * FROM backup_monitors WHERE is_active=true`);
  let abiertos = 0;
  for (const m of mons.rows) {
    if (estadoFrescura(m, now) !== 'vencido') continue;
    await pool.query(`UPDATE backup_monitors SET estado='vencido' WHERE id=$1 AND estado<>'fallo'`, [m.id]);
    const horas = Math.round((m.freshness_seconds || FRESHNESS_SEGUNDOS) / 3600);
    const incId = await abrirIncidenteBackup(pool, m, `Backup vencido: ${m.name}`,
      `Sin copia verificada en mas de ${horas}h (ultima captura UTC: ${m.last_success_captured_at ? new Date(m.last_success_captured_at).toISOString() : 'nunca'})`);
    if (incId) { await pool.query(`UPDATE backup_monitors SET alert_pendiente='vencido' WHERE id=$1`, [m.id]); abiertos++; }
  }
  return { abiertos };
}

// Entrega de avisos pendientes (fallo|vencido|recuperado) con reclamo atomico y
// reintento sin duplicar (mismo patron que lib/url-incidents y lib/offline).
async function entregarAvisosBackup(pool, deps = {}) {
  const notificar = deps.notificar || (async () => {});
  const log = deps.log || (() => {});
  const pend = await pool.query(`SELECT * FROM backup_monitors WHERE alert_pendiente IS NOT NULL`);
  let entregados = 0;
  for (const m of pend.rows) {
    const tipo = m.alert_pendiente;
    const claim = await pool.query(`UPDATE backup_monitors SET alert_pendiente=NULL WHERE id=$1 AND alert_pendiente=$2 RETURNING id`, [m.id, tipo]);
    if (!claim.rows.length) continue;
    try { await notificar(m, tipo); entregados++; }
    catch (e) {
      await pool.query(`UPDATE backup_monitors SET alert_pendiente=$2 WHERE id=$1 AND alert_pendiente IS NULL`, [m.id, tipo]).catch(() => {});
      log(`[BACKUP-AVISO] entrega fallo ${m.name} (${tipo}); se reintentara`);
    }
  }
  return { entregados };
}

module.exports = {
  FRESHNESS_SEGUNDOS, FUTURO_TOLERANCIA_SEG,
  generarToken, hashTokenHex, tokenCoincide,
  validarVerified, validarFailed, estadoFrescura, segundosDesdeCaptura,
  abrirIncidenteBackup, resolverIncidenteBackup,
  ingestarVerified, ingestarFailed, evaluarFrescuraBackups, entregarAvisosBackup
};
