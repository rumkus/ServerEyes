// Fixes de la auditoria de seguridad (hardening).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, levantarServer, registrar } = require('./helpers');
const skip = !hayBase() ? 'TEST_DATABASE_URL no definida: se salta' : false;

let S;
before(async () => { if (!skip) S = await levantarServer(); });
after(async () => { if (S) await S.cerrar(); });
beforeEach(async () => { if (S) await S.limpiar(); });

test('machine_key: lo devuelve CREATE, NO el GET de la lista ni el heartbeat', { skip }, async () => {
  const u = await registrar(S.api, 'mk@demo.com');
  const c = await S.api('POST', '/api/machines', { token: u.token, body: { machine_name: 'M1' } });
  assert.equal(c.status, 201);
  assert.ok(c.data.machine_key, 'el create devuelve la clave (la app la necesita)');
  const key = c.data.machine_key;

  const list = await S.api('GET', '/api/machines', { token: u.token });
  const m = list.data.find(x => x.id === c.data.id);
  assert.equal(m.machine_key, undefined, 'el GET de la lista NO expone la clave');

  const hb = await S.api('POST', '/api/heartbeat', { body: { machine_key: key, public_ip: '8.8.8.8' } });
  assert.equal(hb.status, 200);
  assert.equal(hb.data.machine && hb.data.machine.machine_key, undefined, 'la respuesta del heartbeat NO eco-ea la clave');
});

test('machine_key: un usuario con la maquina COMPARTIDA no ve la clave', { skip }, async () => {
  const A = await registrar(S.api, 'a-mk@demo.com');
  const B = await registrar(S.api, 'b-mk@demo.com');
  const c = await S.api('POST', '/api/machines', { token: A.token, body: { machine_name: 'MA' } });
  await S.pool.query('INSERT INTO machine_shares (machine_id, user_id, shared_by) VALUES ($1,$2,$3)', [c.data.id, B.user.id, A.user.id]);
  const list = await S.api('GET', '/api/machines', { token: B.token });
  const m = list.data.find(x => x.id === c.data.id);
  assert.ok(m, 'B ve la maquina compartida');
  assert.equal(m.is_shared, true);
  assert.equal(m.machine_key, undefined, 'pero NO la credencial del agente');
});

test('IDOR: usuario B no borra el heartbeat_log de la maquina de A', { skip }, async () => {
  const A = await registrar(S.api, 'a-id@demo.com');
  const B = await registrar(S.api, 'b-id@demo.com');
  const c = await S.api('POST', '/api/machines', { token: A.token, body: { machine_name: 'MA' } });
  await S.pool.query(`INSERT INTO heartbeat_log (machine_id, public_ip) VALUES ($1,'1.2.3.4')`, [c.data.id]);
  await S.api('DELETE', '/api/machines/' + c.data.id, { token: B.token });
  const hb = await S.pool.query('SELECT COUNT(*)::int n FROM heartbeat_log WHERE machine_id=$1', [c.data.id]);
  assert.ok(hb.rows[0].n >= 1, 'el historial de A no se borro');
  const mach = await S.pool.query('SELECT COUNT(*)::int n FROM machines WHERE id=$1', [c.data.id]);
  assert.equal(mach.rows[0].n, 1, 'la maquina de A sigue');
});

test('SMTP anti-SSRF: rechaza hosts internos, acepta uno publico', { skip }, async () => {
  const u = await registrar(S.api, 'smtp@demo.com');
  for (const h of ['localhost', '127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.5']) {
    const r = await S.api('POST', '/api/auth/smtp', { token: u.token, body: { smtp_host: h, smtp_user: 'x', smtp_from: 'x@x.com' } });
    assert.equal(r.status, 400, 'debe rechazar ' + h);
  }
  // smtp_secure:true evita un quirk pre-existente del endpoint (smtp_secure||'tls'
  // rompe la columna boolean cuando viene false); ajeno a este fix de seguridad.
  const ok = await S.api('POST', '/api/auth/smtp', { token: u.token, body: { smtp_host: '8.8.8.8', smtp_port: 465, smtp_secure: true, smtp_user: 'x', smtp_from: 'x@x.com' } });
  assert.equal(ok.status, 200, 'acepta un host publico');
  const vacio = await S.api('POST', '/api/auth/smtp', { token: u.token, body: { smtp_host: '', smtp_secure: true, smtp_user: '' } });
  assert.equal(vacio.status, 200, 'vacio = limpiar, ok');
});

test('SMTP secure: la app manda "tls"/"ssl" (string) -> se guarda como boolean (bug fix)', { skip }, async () => {
  const u = await registrar(S.api, 'smtps@demo.com');
  let r = await S.api('POST', '/api/auth/smtp', { token: u.token, body: { smtp_host: '8.8.8.8', smtp_port: 587, smtp_secure: 'tls', smtp_user: 'x', smtp_from: 'x@x.com' } });
  assert.equal(r.status, 200, '"tls" ya no da 500');
  let g = await S.api('GET', '/api/auth/smtp', { token: u.token });
  assert.equal(g.data.smtp_secure, false, '"tls" -> false');
  r = await S.api('POST', '/api/auth/smtp', { token: u.token, body: { smtp_host: '8.8.8.8', smtp_port: 465, smtp_secure: 'ssl', smtp_user: 'x', smtp_from: 'x@x.com' } });
  assert.equal(r.status, 200);
  g = await S.api('GET', '/api/auth/smtp', { token: u.token });
  assert.equal(g.data.smtp_secure, true, '"ssl" -> true');
});

test('limite JSON: 2mb global rechaza; agent/upload acepta grande', { skip }, async () => {
  const big = { x: 'a'.repeat(3 * 1024 * 1024) }; // ~3mb
  // Ruta normal: el parser chico (2mb) la rechaza con 413 antes de cualquier handler.
  const r1 = await S.api('POST', '/api/auth/login', { body: big });
  assert.equal(r1.status, 413, 'body >2mb en ruta normal -> 413');
  // agent/upload: el parser grande (80mb) acepta el body; sin token cae en 401 (no 413).
  const r2 = await S.api('POST', '/api/admin/agent/upload', { body: big });
  assert.notEqual(r2.status, 413, 'agent/upload no rechaza por tamaño');
});

test('helmet: cabeceras de seguridad presentes', { skip }, async () => {
  const r = await S.api('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('x-frame-options'), 'X-Frame-Options presente');
});
