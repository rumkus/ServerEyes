// Aviso de recuperacion (maquina online de nuevo).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, levantarServer, registrar } = require('./helpers');
const skip = !hayBase() ? 'TEST_DATABASE_URL no definida: se salta' : false;

let S;
before(async () => { if (!skip) S = await levantarServer(); });
after(async () => { if (S) await S.cerrar(); });
beforeEach(async () => { if (S) await S.limpiar(); });

async function crearMaquina(userId, { is_online = false, offline_notified = true, alert_offline = true } = {}) {
  const key = 'key-' + Math.random().toString(36).slice(2);
  const r = await S.pool.query(
    `INSERT INTO machines (user_id, machine_name, machine_key, is_online, offline_notified, alert_offline, last_heartbeat)
     VALUES ($1,'SRV-TEST',$2,$3,$4,$5, NOW()-INTERVAL '5 minutes') RETURNING *`,
    [userId, key, is_online, offline_notified, alert_offline]
  );
  return r.rows[0];
}

test('gate: solo avisa recuperacion si la caida se alerto y las alertas offline estan ON', { skip }, async () => {
  const { debeAvisarRecuperacion } = require('../server');
  assert.equal(debeAvisarRecuperacion(true, true), true);
  assert.equal(debeAvisarRecuperacion(true, undefined), true);   // alert_offline no seteado = ON
  assert.equal(debeAvisarRecuperacion(false, true), false);      // nunca se alerto (micro-corte)
  assert.equal(debeAvisarRecuperacion(true, false), false);      // alertas offline desactivadas
  assert.equal(debeAvisarRecuperacion(undefined, true), false);  // primer heartbeat
});

test('heartbeat tras offline-alertado: repone online, resuelve incidente, registra uptime online', { skip }, async () => {
  const u = await registrar(S.api, 'rec@demo.com');
  const m = await crearMaquina(u.user.id, { is_online: false, offline_notified: true });
  await S.pool.query(`INSERT INTO uptime_log (machine_id, status) VALUES ($1,'offline')`, [m.id]);
  const incId = (await S.pool.query(
    `INSERT INTO incidents (machine_id, user_id, title, status) VALUES ($1,$2,'offline','open') RETURNING id`,
    [m.id, u.user.id])).rows[0].id;

  const r = await S.api('POST', '/api/heartbeat', { body: { machine_key: m.machine_key, public_ip: '8.8.8.8' } });
  assert.equal(r.status, 200);

  const mon = (await S.pool.query('SELECT is_online, offline_notified FROM machines WHERE id=$1', [m.id])).rows[0];
  assert.equal(mon.is_online, true);
  assert.equal(mon.offline_notified, false);
  const inc = (await S.pool.query('SELECT status FROM incidents WHERE id=$1', [incId])).rows[0];
  assert.equal(inc.status, 'resolved');
  const up = (await S.pool.query('SELECT status FROM uptime_log WHERE machine_id=$1 ORDER BY timestamp DESC LIMIT 1', [m.id])).rows[0];
  assert.equal(up.status, 'online');
});

test('heartbeat de maquina que nunca estuvo offline: no rompe, queda online', { skip }, async () => {
  const u = await registrar(S.api, 'rec2@demo.com');
  const m = await crearMaquina(u.user.id, { is_online: true, offline_notified: false });
  await S.pool.query(`INSERT INTO uptime_log (machine_id, status) VALUES ($1,'online')`, [m.id]);
  const r = await S.api('POST', '/api/heartbeat', { body: { machine_key: m.machine_key, public_ip: '8.8.8.8' } });
  assert.equal(r.status, 200);
  const mon = (await S.pool.query('SELECT is_online FROM machines WHERE id=$1', [m.id])).rows[0];
  assert.equal(mon.is_online, true);
});
