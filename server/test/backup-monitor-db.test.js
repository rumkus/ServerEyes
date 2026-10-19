// Integracion del monitor de backups contra Postgres de PRUEBAS.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, levantarServer, registrar } = require('./helpers');
const b = require('../lib/backup-monitor');
const skip = !hayBase() ? 'TEST_DATABASE_URL no definida: se salta' : false;

let S;
before(async () => { if (!skip) S = await levantarServer(); });
after(async () => { if (S) await S.cerrar(); });
beforeEach(async () => { if (S) await S.limpiar(); }); // CASCADE limpia backup_monitors/events/incidents

async function admin(email = 'badmin@demo.com') {
  const u = await registrar(S.api, email);
  await S.pool.query(`UPDATE users SET is_admin=true WHERE id=$1`, [u.user.id]);
  return u;
}
async function crearMonitor(userId, token = 'tok-prueba', fresh = 93600) {
  const r = await S.pool.query(
    `INSERT INTO backup_monitors (user_id,name,environment,token_hash,freshness_seconds,estado)
     VALUES ($1,'Linde/staging backups Google Drive','staging',$2,$3,'pendiente') RETURNING *`,
    [userId, b.hashTokenHex(token), fresh]);
  return r.rows[0];
}
const mon = async (id) => (await S.pool.query(`SELECT * FROM backup_monitors WHERE id=$1`, [id])).rows[0];
const incs = async (id) => (await S.pool.query(`SELECT * FROM incidents WHERE backup_monitor_id=$1 ORDER BY id`, [id])).rows;
const verifiedEv = (over = {}) => ({ backupId: 'bk-1', capturedAt: new Date().toISOString(), bytes: 818056, sha256: 'a'.repeat(64), fileId: 'f1', ...over });

test('verified: aplica, estado saludable, dedup y conflicto', { skip }, async () => {
  const u = await admin(); const m = await crearMonitor(u.user.id);
  let r = await b.ingestarVerified(S.pool, m, verifiedEv());
  assert.equal(r.resultado, 'aplicado');
  assert.equal((await mon(m.id)).estado, 'saludable');
  assert.equal((await mon(m.id)).last_success_backup_id, 'bk-1');
  // duplicado identico: no cambia
  r = await b.ingestarVerified(S.pool, await mon(m.id), verifiedEv());
  assert.equal(r.resultado, 'duplicado');
  // conflicto: mismo backupId, distinto sha
  r = await b.ingestarVerified(S.pool, await mon(m.id), verifiedEv({ sha256: 'b'.repeat(64) }));
  assert.equal(r.resultado, 'conflicto');
});

test('verified fuera de orden: una captura mas vieja NO reemplaza la mas nueva', { skip }, async () => {
  const u = await admin(); const m = await crearMonitor(u.user.id);
  const nueva = new Date().toISOString();
  const vieja = new Date(Date.now() - 3600 * 1000).toISOString();
  await b.ingestarVerified(S.pool, m, verifiedEv({ backupId: 'nueva', capturedAt: nueva }));
  const r = await b.ingestarVerified(S.pool, await mon(m.id), verifiedEv({ backupId: 'vieja', capturedAt: vieja }));
  assert.equal(r.resultado, 'viejo');
  assert.equal((await mon(m.id)).last_success_backup_id, 'nueva');
});

test('verified con captura VIEJA recibida ahora: no renueva salud (estado vencido)', { skip }, async () => {
  const u = await admin(); const m = await crearMonitor(u.user.id);
  const vieja = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const r = await b.ingestarVerified(S.pool, m, verifiedEv({ capturedAt: vieja }));
  assert.equal(r.resultado, 'aplicado');
  assert.equal((await mon(m.id)).estado, 'vencido');
});

test('failed: abre UN incidente; duplicado no reabre; superado por exito posterior', { skip }, async () => {
  const u = await admin(); const m = await crearMonitor(u.user.id);
  let r = await b.ingestarFailed(S.pool, m, { runId: 'run-1', reason: 'dump fallo', failedAt: new Date().toISOString() });
  assert.equal(r.resultado, 'aplicado');
  assert.equal((await incs(m.id)).filter(i => i.status === 'open').length, 1);
  assert.equal((await mon(m.id)).estado, 'fallo');
  // duplicado por runId
  r = await b.ingestarFailed(S.pool, await mon(m.id), { runId: 'run-1', reason: 'x', failedAt: new Date().toISOString() });
  assert.equal(r.resultado, 'duplicado');
  // superado: exito con captura POSTERIOR al fallo -> un fallo viejo no abre incidente
  await b.ingestarVerified(S.pool, await mon(m.id), verifiedEv({ backupId: 'ok-later', capturedAt: new Date().toISOString() }));
  r = await b.ingestarFailed(S.pool, await mon(m.id), { runId: 'run-old', reason: 'viejo', failedAt: new Date(Date.now() - 3600 * 1000).toISOString() });
  assert.equal(r.resultado, 'superado');
});

test('recuperacion: verified reciente cierra el incidente de fallo y deja aviso', { skip }, async () => {
  const u = await admin(); const m = await crearMonitor(u.user.id);
  await b.ingestarFailed(S.pool, m, { runId: 'run-1', reason: 'fallo', failedAt: new Date().toISOString() });
  assert.equal((await incs(m.id)).filter(i => i.status === 'open').length, 1);
  await S.pool.query(`UPDATE backup_monitors SET alert_pendiente=NULL WHERE id=$1`, [m.id]); // simulamos aviso 'fallo' ya entregado
  await b.ingestarVerified(S.pool, await mon(m.id), verifiedEv({ backupId: 'recu', capturedAt: new Date().toISOString() }));
  assert.equal((await incs(m.id)).filter(i => i.status === 'resolved').length, 1);
  assert.equal((await mon(m.id)).alert_pendiente, 'recuperado');
});

test('frescura (scheduler): copia vencida abre incidente unico; idempotente', { skip }, async () => {
  const u = await admin(); const m = await crearMonitor(u.user.id);
  await S.pool.query(`UPDATE backup_monitors SET last_success_captured_at=NOW()-INTERVAL '48 hours', estado='saludable' WHERE id=$1`, [m.id]);
  let r = await b.evaluarFrescuraBackups(S.pool);
  assert.equal(r.abiertos, 1);
  assert.equal((await mon(m.id)).estado, 'vencido');
  r = await b.evaluarFrescuraBackups(S.pool); // segunda pasada no duplica
  assert.equal(r.abiertos, 0);
  assert.equal((await incs(m.id)).filter(i => i.status === 'open').length, 1);
});

test('frescura: pendiente (sin captura) NO abre incidente', { skip }, async () => {
  const u = await admin(); const m = await crearMonitor(u.user.id);
  const r = await b.evaluarFrescuraBackups(S.pool);
  assert.equal(r.abiertos, 0);
  assert.equal((await mon(m.id)).estado, 'pendiente');
});

test('entrega: reintento revierte sin duplicar; concurrencia avisa una vez', { skip }, async () => {
  const u = await admin(); const m = await crearMonitor(u.user.id);
  await S.pool.query(`UPDATE backup_monitors SET alert_pendiente='vencido' WHERE id=$1`, [m.id]);
  let r = await b.entregarAvisosBackup(S.pool, { notificar: async () => { throw new Error('canal caido'); } });
  assert.equal(r.entregados, 0);
  assert.equal((await mon(m.id)).alert_pendiente, 'vencido');
  let llamadas = 0;
  const notificar = async () => { await new Promise(x => setTimeout(x, 20)); llamadas++; };
  await Promise.all([b.entregarAvisosBackup(S.pool, { notificar }), b.entregarAvisosBackup(S.pool, { notificar })]);
  assert.equal(llamadas, 1);
  assert.equal((await mon(m.id)).alert_pendiente, null);
});

// ---- API: ingestion token auth + HTTP codes + aislamiento + rotate ----
test('API ingestion: token malo 401, bueno 200; invalido 400; conflicto 409', { skip }, async () => {
  const u = await admin(); const m = await crearMonitor(u.user.id, 'tok-bueno');
  // El API exige el evento completo (incl. downloadVerified:true), como lo emite el exportador.
  const ev = { event: 'offsite_backup_verified', downloadVerified: true, ...verifiedEv() };
  // token malo
  let r = await S.api('POST', `/api/backup-monitors/${m.id}/events`, { headers: { Authorization: 'Bearer malo' }, body: ev });
  assert.equal(r.status, 401);
  // token bueno
  r = await S.api('POST', `/api/backup-monitors/${m.id}/events`, { headers: { Authorization: 'Bearer tok-bueno' }, body: ev });
  assert.equal(r.status, 200); assert.equal(r.data.resultado, 'aplicado');
  // invalido (bytes 0)
  r = await S.api('POST', `/api/backup-monitors/${m.id}/events`, { headers: { Authorization: 'Bearer tok-bueno' }, body: { event: 'offsite_backup_verified', downloadVerified: true, ...verifiedEv({ backupId: 'bk2', bytes: 0 }) } });
  assert.equal(r.status, 400);
  // conflicto (mismo backupId distinto sha)
  r = await S.api('POST', `/api/backup-monitors/${m.id}/events`, { headers: { Authorization: 'Bearer tok-bueno' }, body: { event: 'offsite_backup_verified', downloadVerified: true, ...verifiedEv({ sha256: 'c'.repeat(64) }) } });
  assert.equal(r.status, 409);
});

test('API aislamiento: usuario B no ve el monitor de A; rotate es admin y da token una vez', { skip }, async () => {
  const A = await admin('a-bk@demo.com'); const m = await crearMonitor(A.user.id);
  const B = await registrar(S.api, 'b-bk@demo.com');
  // B (no admin, no dueno) no ve ni incidentes ni eventos
  assert.equal((await S.api('GET', `/api/backup-monitors/${m.id}/incidents`, { token: B.token })).status, 404);
  assert.equal((await S.api('GET', `/api/backup-monitors/${m.id}/events`, { token: B.token })).status, 404);
  const listaB = await S.api('GET', '/api/backup-monitors', { token: B.token });
  assert.equal(listaB.data.length, 0);
  // rotate requiere admin; B (no admin) 403
  assert.equal((await S.api('POST', `/api/backup-monitors/${m.id}/rotate-token`, { token: B.token })).status, 403);
  // A (admin) obtiene token
  const rot = await S.api('POST', `/api/backup-monitors/${m.id}/rotate-token`, { token: A.token });
  assert.equal(rot.status, 200);
  assert.match(rot.data.token, /^[a-f0-9]{64}$/);
  // el GET nunca expone el hash del token
  const lista = await S.api('GET', '/api/backup-monitors', { token: A.token });
  assert.equal(lista.data[0].token_hash, undefined);
  assert.equal(lista.data[0].tiene_token, true);
});
