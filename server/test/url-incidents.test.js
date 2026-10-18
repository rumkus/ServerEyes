// Integracion de incidentes + avisos de URL contra Postgres de PRUEBAS.
// Verifica: incidente unico por caida (idempotente), recuperacion que lo
// resuelve, reintento de entrega que revierte sin duplicar, deduplicacion,
// claim atomico ante workers concurrentes, y que una recuperacion previa a la
// entrega de la caida NO genera aviso espureo.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, levantarServer, registrar } = require('./helpers');
const inc = require('../lib/url-incidents');
const skip = !hayBase() ? 'TEST_DATABASE_URL no definida: se salta' : false;

let S, userId;
before(async () => { if (!skip) S = await levantarServer(); });
after(async () => { if (S) await S.cerrar(); });
beforeEach(async () => {
  if (!S) return;
  await S.limpiar();
  const u = await registrar(S.api, 'inc@demo.com');
  userId = u.user.id;
});

// Crea un monitor directo en DB con el estado inicial pedido.
async function crearMon(isUp = true, notify = true) {
  const r = await S.pool.query(
    `INSERT INTO url_monitors (user_id, url, name, interval_seconds, timeout_ms, is_active, is_up, notify_down)
     VALUES ($1,'https://x.test/health','X',300,10000,true,$2,$3) RETURNING *`, [userId, isUp, notify]);
  return r.rows[0];
}
const incidentesDe = async (id) => (await S.pool.query(`SELECT * FROM incidents WHERE url_id=$1 ORDER BY id`, [id])).rows;
const monDe = async (id) => (await S.pool.query(`SELECT * FROM url_monitors WHERE id=$1`, [id])).rows[0];
async function marcar(id, isUp) { await S.pool.query(`UPDATE url_monitors SET is_up=$2, down_since=CASE WHEN $2=false THEN NOW() ELSE NULL END WHERE id=$1`, [id, isUp]); }

test('caida: abre UN solo incidente y es idempotente', { skip }, async () => {
  const m = await crearMon(true);
  await marcar(m.id, false);
  await inc.aplicarTransicionUrl(S.pool, { ...m, is_up: false, last_error: 'HTTP 503' }, false, true);
  let incs = await incidentesDe(m.id);
  assert.equal(incs.length, 1);
  assert.equal(incs[0].status, 'open');
  assert.equal((await monDe(m.id)).alert_pendiente, 'down');
  // segunda caida sin recuperar: no duplica
  assert.equal(await inc.abrirIncidenteUrl(S.pool, { ...m, is_up: false }), null);
  incs = await incidentesDe(m.id);
  assert.equal(incs.length, 1);
});

test('recuperacion: resuelve el incidente y deja aviso up (si la caida se habia avisado)', { skip }, async () => {
  const m = await crearMon(true);
  await marcar(m.id, false);
  await inc.aplicarTransicionUrl(S.pool, { ...m, is_up: false }, false, true);
  // simulamos que el aviso 'down' ya se entrego (alert_pendiente -> NULL)
  await S.pool.query(`UPDATE url_monitors SET alert_pendiente=NULL WHERE id=$1`, [m.id]);
  await marcar(m.id, true);
  await inc.aplicarTransicionUrl(S.pool, { ...m, is_up: true }, true, false);
  const incs = await incidentesDe(m.id);
  assert.equal(incs.length, 1);
  assert.equal(incs[0].status, 'resolved');
  assert.ok(incs[0].ended_at);
  assert.equal((await monDe(m.id)).alert_pendiente, 'up');
});

test('recuperacion ANTES de entregar la caida: no genera aviso up espureo', { skip }, async () => {
  const m = await crearMon(true);
  await marcar(m.id, false);
  await inc.aplicarTransicionUrl(S.pool, { ...m, is_up: false }, false, true); // alert_pendiente='down'
  await marcar(m.id, true);
  await inc.aplicarTransicionUrl(S.pool, { ...m, is_up: true }, true, false);
  assert.equal((await monDe(m.id)).alert_pendiente, null); // ni down ni up
  assert.equal((await incidentesDe(m.id))[0].status, 'resolved');
});

test('entrega con reintento: si falla, revierte y reintenta sin duplicar', { skip }, async () => {
  const m = await crearMon(true);
  await marcar(m.id, false);
  await inc.aplicarTransicionUrl(S.pool, { ...m, is_up: false }, false, true);
  // 1er intento: el envio falla -> se revierte alert_pendiente
  let r = await inc.entregarAvisosUrl(S.pool, { notificar: async () => { throw new Error('SMTP caido'); } });
  assert.equal(r.entregados, 0);
  assert.equal((await monDe(m.id)).alert_pendiente, 'down');
  // 2do intento: el envio anda -> entrega y limpia
  let llamadas = 0;
  r = await inc.entregarAvisosUrl(S.pool, { notificar: async () => { llamadas++; } });
  assert.equal(r.entregados, 1);
  assert.equal(llamadas, 1);
  assert.equal((await monDe(m.id)).alert_pendiente, null);
});

test('deduplicacion: sin nuevo cambio de estado no se vuelve a avisar', { skip }, async () => {
  const m = await crearMon(true);
  await marcar(m.id, false);
  await inc.aplicarTransicionUrl(S.pool, { ...m, is_up: false }, false, true);
  let llamadas = 0;
  await inc.entregarAvisosUrl(S.pool, { notificar: async () => { llamadas++; } });
  await inc.entregarAvisosUrl(S.pool, { notificar: async () => { llamadas++; } });
  assert.equal(llamadas, 1); // solo la primera entrego; la 2da no tiene pendiente
});

test('concurrencia: dos entregas en paralelo avisan UNA sola vez (claim atomico)', { skip }, async () => {
  const m = await crearMon(true);
  await marcar(m.id, false);
  await inc.aplicarTransicionUrl(S.pool, { ...m, is_up: false }, false, true);
  let llamadas = 0;
  const notificar = async () => { await new Promise(r => setTimeout(r, 30)); llamadas++; };
  await Promise.all([
    inc.entregarAvisosUrl(S.pool, { notificar }),
    inc.entregarAvisosUrl(S.pool, { notificar }),
  ]);
  assert.equal(llamadas, 1);
  assert.equal((await monDe(m.id)).alert_pendiente, null);
});

test('pausar un monitor caido no resuelve el incidente ni avisa recuperacion', { skip }, async () => {
  const m = await crearMon(true);
  await marcar(m.id, false);
  await inc.aplicarTransicionUrl(S.pool, { ...m, is_up: false }, false, true);
  await S.pool.query(`UPDATE url_monitors SET alert_pendiente=NULL WHERE id=$1`, [m.id]); // ya avisado
  // "pausar": is_active=false. El checker no corre -> no hay transicion.
  await S.pool.query(`UPDATE url_monitors SET is_active=false WHERE id=$1`, [m.id]);
  const incs = await incidentesDe(m.id);
  assert.equal(incs[0].status, 'open');               // sigue abierto
  assert.equal((await monDe(m.id)).alert_pendiente, null); // no se genero aviso 'up'
});
