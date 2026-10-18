// Integracion del API de monitores health-check contra una base de PRUEBAS
// (TEST_DATABASE_URL). Sin esa variable se saltan. Valida el SQL agregado:
// columnas nuevas, POST/PUT con campos de health-check y el estado computado
// (sin_comprobar / saludable / caido / desactualizado) del GET.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, levantarServer, registrar } = require('./helpers');
const skip = !hayBase() ? 'TEST_DATABASE_URL no definida: se salta' : false;

let S;
before(async () => { if (!skip) S = await levantarServer(); });
after(async () => { if (S) await S.cerrar(); });
beforeEach(async () => {
  if (!S) return;
  await S.limpiar();
  // El tick del scheduler vive en app_settings (no lo toca TRUNCATE): lo limpiamos
  // para que cada prueba controle si el verificador figura activo o pausado.
  await S.pool.query(`DELETE FROM app_settings WHERE key IN ('url_checker_last_tick','url_checker_last_gap')`);
});

const tickReciente = () => S.pool.query(
  `INSERT INTO app_settings(key,value) VALUES('url_checker_last_tick',$1)
   ON CONFLICT(key) DO UPDATE SET value=$1`, [new Date().toISOString()]);

test('crea health-check con expected_json; arranca en estado sin_comprobar', { skip }, async () => {
  const { token } = await registrar(S.api, 'a@a.com');
  const c = await S.api('POST', '/api/url-monitors', { token, body: {
    url: 'https://api-staging-46412.up.railway.app/health/ready', name: 'API',
    health_mode: true, enforce_tls: true, expected_json: { status: 'ok', service: 'api' }
  }});
  assert.equal(c.status, 200);
  assert.equal(c.data.health_mode, true);
  assert.equal(c.data.enforce_tls, true);
  assert.deepEqual(c.data.expected_json, { status: 'ok', service: 'api' });
  assert.equal(c.data.interval_seconds, 300);
  assert.equal(c.data.timeout_ms, 10000);

  const g = await S.api('GET', '/api/url-monitors', { token });
  const m = g.data.find(x => x.id === c.data.id);
  assert.equal(m.estado, 'sin_comprobar');
  assert.equal(m.scheduler_pausado, false);
});

test('expected_json invalido (array) se rechaza con 400', { skip }, async () => {
  const { token } = await registrar(S.api, 'b@b.com');
  const c = await S.api('POST', '/api/url-monitors', { token, body: { url: 'https://example.com/', expected_json: [1, 2] } });
  assert.equal(c.status, 400);
});

test('PUT setea y despues limpia health_mode/expected_json/enforce_tls', { skip }, async () => {
  const { token } = await registrar(S.api, 'c@c.com');
  const c = await S.api('POST', '/api/url-monitors', { token, body: { url: 'https://example.com/' } });
  assert.equal(c.data.health_mode, false);

  let u = await S.api('PUT', '/api/url-monitors/' + c.data.id, { token, body: { health_mode: true, expected_json: { a: 'b' }, enforce_tls: true } });
  assert.equal(u.status, 200);
  assert.equal(u.data.health_mode, true);
  assert.deepEqual(u.data.expected_json, { a: 'b' });
  assert.equal(u.data.enforce_tls, true);

  u = await S.api('PUT', '/api/url-monitors/' + c.data.id, { token, body: { expected_json: null, health_mode: false } });
  assert.equal(u.status, 200);
  assert.equal(u.data.expected_json, null);
  assert.equal(u.data.health_mode, false);
  assert.equal(u.data.enforce_tls, true); // no se toco: sigue en true
});

test('estado saludable vs caido (con outage) con el scheduler activo', { skip }, async () => {
  const { token } = await registrar(S.api, 'e@e.com');
  const c = await S.api('POST', '/api/url-monitors', { token, body: { url: 'https://example.com/', interval_seconds: 300 } });
  await tickReciente();

  await S.pool.query(`UPDATE url_monitors SET last_check=NOW(), is_up=true WHERE id=$1`, [c.data.id]);
  let g = await S.api('GET', '/api/url-monitors', { token });
  assert.equal(g.data.find(x => x.id === c.data.id).estado, 'saludable');

  await S.pool.query(`UPDATE url_monitors SET last_check=NOW(), is_up=false, down_since=NOW()-INTERVAL '120 seconds' WHERE id=$1`, [c.data.id]);
  g = await S.api('GET', '/api/url-monitors', { token });
  const m = g.data.find(x => x.id === c.data.id);
  assert.equal(m.estado, 'caido');
  assert.ok(m.outage_seconds >= 100, 'outage_seconds=' + m.outage_seconds);
});

test('estado desactualizado: ultima medicion vieja aunque is_up=true', { skip }, async () => {
  const { token } = await registrar(S.api, 'd@d.com');
  const c = await S.api('POST', '/api/url-monitors', { token, body: { url: 'https://example.com/', interval_seconds: 300 } });
  await tickReciente();
  await S.pool.query(`UPDATE url_monitors SET last_check=NOW()-INTERVAL '2 hours', is_up=true WHERE id=$1`, [c.data.id]);
  const g = await S.api('GET', '/api/url-monitors', { token });
  assert.equal(g.data.find(x => x.id === c.data.id).estado, 'desactualizado');
});

test('scheduler pausado: tick viejo marca todo desactualizado', { skip }, async () => {
  const { token } = await registrar(S.api, 'f@f.com');
  const c = await S.api('POST', '/api/url-monitors', { token, body: { url: 'https://example.com/', interval_seconds: 300 } });
  await S.pool.query(`UPDATE url_monitors SET last_check=NOW(), is_up=true WHERE id=$1`, [c.data.id]);
  // tick de hace 10 min: el verificador no corre -> no mostrar como actual
  await S.pool.query(`INSERT INTO app_settings(key,value) VALUES('url_checker_last_tick',$1)
     ON CONFLICT(key) DO UPDATE SET value=$1`, [new Date(Date.now() - 600000).toISOString()]);
  const g = await S.api('GET', '/api/url-monitors', { token });
  const m = g.data.find(x => x.id === c.data.id);
  assert.equal(m.scheduler_pausado, true);
  assert.equal(m.estado, 'desactualizado');
});

test('GET expone proxima_check cuando ya hubo una comprobacion', { skip }, async () => {
  const { token } = await registrar(S.api, 'g@g.com');
  const c = await S.api('POST', '/api/url-monitors', { token, body: { url: 'https://example.com/', interval_seconds: 300 } });
  await tickReciente();
  await S.pool.query(`UPDATE url_monitors SET last_check=NOW(), is_up=true WHERE id=$1`, [c.data.id]);
  const g = await S.api('GET', '/api/url-monitors', { token });
  const m = g.data.find(x => x.id === c.data.id);
  assert.ok(m.proxima_check, 'proxima_check presente');
  assert.ok(new Date(m.proxima_check).getTime() > Date.now(), 'proxima_check en el futuro');
});

test('endpoint de incidentes del monitor devuelve los abiertos/resueltos', { skip }, async () => {
  const { token } = await registrar(S.api, 'h@h.com');
  const c = await S.api('POST', '/api/url-monitors', { token, body: { url: 'https://example.com/', health_mode: true } });
  // abrimos un incidente directo (como lo haria la transicion)
  await S.pool.query(`UPDATE url_monitors SET is_up=false, down_since=NOW() WHERE id=$1`, [c.data.id]);
  await S.pool.query(`INSERT INTO incidents (url_id, user_id, title, status) VALUES ($1,$2,'caido','open')`, [c.data.id, (await S.pool.query('SELECT user_id FROM url_monitors WHERE id=$1',[c.data.id])).rows[0].user_id]);
  const r = await S.api('GET', '/api/url-monitors/' + c.data.id + '/incidents', { token });
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].status, 'open');
});

test('aislamiento: usuario B no ve ni toca el monitor de A', { skip }, async () => {
  const A = await registrar(S.api, 'a-iso@demo.com');
  const B = await registrar(S.api, 'b-iso@demo.com');
  const c = await S.api('POST', '/api/url-monitors', { token: A.token, body: { url: 'https://example.com/' } });
  // B no lo ve en su lista
  const lista = await S.api('GET', '/api/url-monitors', { token: B.token });
  assert.equal(lista.data.find(x => x.id === c.data.id), undefined);
  // B no accede a historial/incidentes/edicion/borrado
  assert.equal((await S.api('GET', '/api/url-monitors/' + c.data.id + '/history', { token: B.token })).status, 404);
  assert.equal((await S.api('GET', '/api/url-monitors/' + c.data.id + '/incidents', { token: B.token })).status, 404);
  const put = await S.api('PUT', '/api/url-monitors/' + c.data.id, { token: B.token, body: { name: 'hack' } });
  assert.equal(put.status, 404);
  // sin token: 401
  assert.equal((await S.api('GET', '/api/url-monitors')).status, 401);
});
