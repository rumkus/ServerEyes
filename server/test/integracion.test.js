// Pruebas de las rutas contra una base de pruebas aislada (TEST_DATABASE_URL).
// Sin esa variable se saltan enteras.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { hayBase, levantarServer, registrar } = require('./helpers');

const skip = !hayBase() ? 'TEST_DATABASE_URL no definida: se salta la integracion' : false;

let S;
before(async () => { if (!skip) S = await levantarServer(); });
after(async () => { if (S) { await S.limpiar(); await S.cerrar(); } });
beforeEach(async () => { if (S) await S.limpiar(); });

const firmar = (machineKey, ...partes) => crypto.createHmac('sha256', machineKey).update(partes.join('\u0000')).digest('hex');

async function vincular(api, token, nombre = 'pc-test') {
  const req = await api('POST', '/api/pairing/request', { body: { machine_name: nombre, os_info: 'test' } });
  const conf = await api('POST', '/api/pairing/confirm', { body: { code: req.data.code }, token });
  assert.equal(conf.status, 200);
  const st = await api('GET', '/api/pairing/status/' + req.data.code, { headers: { 'X-Pairing-Token': req.data.pairing_token } });
  assert.equal(st.data.confirmed, true);
  return { machineId: conf.data.machine.id, machineKey: st.data.machine_key };
}

const latido = (api, machineKey) => api('POST', '/api/heartbeat', { body: { machine_key: machineKey, machine_name: 'pc-test', public_ip: '203.0.113.5', local_ip: '10.0.0.2', os_info: 'test', agent_version: '1.4.0', agent_type: 'agent' } });

// ================= PAIRING =================
test('pairing: sin X-Pairing-Token no se consulta ni se retira la clave', { skip }, async () => {
  const { api } = S;
  const { token } = await registrar(api, 'p1@test.local');
  const req = await api('POST', '/api/pairing/request', { body: { machine_name: 'pc' } });
  assert.equal(req.status, 200);
  assert.match(req.data.code, /^\d{6}$/);
  assert.equal(typeof req.data.pairing_token, 'string');

  const conf = await api('POST', '/api/pairing/confirm', { body: { code: req.data.code }, token });
  assert.equal(conf.status, 200);
  assert.equal(conf.data.machine.machine_key, undefined, 'la app no recibe la machine_key');

  const sinToken = await api('GET', '/api/pairing/status/' + req.data.code);
  assert.equal(sinToken.status, 401);
  const tokenMalo = await api('GET', '/api/pairing/status/' + req.data.code, { headers: { 'X-Pairing-Token': 'f'.repeat(64) } });
  assert.equal(tokenMalo.status, 401);
  assert.equal(tokenMalo.data.machine_key, undefined);

  const ok = await api('GET', '/api/pairing/status/' + req.data.code, { headers: { 'X-Pairing-Token': req.data.pairing_token } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.confirmed, true);
  assert.match(ok.data.machine_key, /^[0-9a-f]{32}$/);
  // Recuperable con el mismo token mientras el codigo este vigente (respuestas perdidas)
  for (let i = 0; i < 7; i++) {
    const otraVez = await api('GET', '/api/pairing/status/' + req.data.code, { headers: { 'X-Pairing-Token': req.data.pairing_token } });
    assert.equal(otraVez.status, 200, 'lectura ' + (i + 2));
    assert.equal(otraVez.data.machine_key, ok.data.machine_key);
  }
  assert.equal((await api('GET', '/api/pairing/status/' + req.data.code)).status, 401, 'sin token sigue sin servir');
});

test('pairing: confirm exige sesion y el codigo se usa una sola vez', { skip }, async () => {
  const { api } = S;
  const { token } = await registrar(api, 'p2@test.local');
  const req = await api('POST', '/api/pairing/request', { body: { machine_name: 'pc' } });
  assert.equal((await api('POST', '/api/pairing/confirm', { body: { code: req.data.code } })).status, 401);
  assert.equal((await api('POST', '/api/pairing/confirm', { body: { code: req.data.code }, token })).status, 200);
  assert.equal((await api('POST', '/api/pairing/confirm', { body: { code: req.data.code }, token })).status, 409);
  assert.equal((await api('POST', '/api/pairing/confirm', { body: { code: '000000' }, token })).status, 404);
});

// ================= SESIONES =================
test('sesiones: cambiar la contraseña revoca el token viejo y entrega uno nuevo', { skip }, async () => {
  const { api } = S;
  const { token, password } = await registrar(api, 's1@test.local');
  const otroDispositivo = (await api('POST', '/api/auth/login', { body: { email: 's1@test.local', password } })).data.token;
  assert.equal((await api('GET', '/api/machines', { token: otroDispositivo })).status, 200);

  const cambio = await api('POST', '/api/auth/change-password', { body: { current_password: password, new_password: 'nueva456' }, token });
  assert.equal(cambio.status, 200);
  assert.equal(typeof cambio.data.token, 'string');

  const viejo = await api('GET', '/api/machines', { token: otroDispositivo });
  assert.equal(viejo.status, 401);
  assert.equal(viejo.data.code, 'SESSION_REVOKED');
  assert.equal((await api('GET', '/api/machines', { token })).status, 401, 'el token con el que se cambio tambien cae');
  assert.equal((await api('GET', '/api/machines', { token: cambio.data.token })).status, 200, 'el nuevo entra');
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 's1@test.local', password: 'nueva456' } })).status, 200);
});

test('sesiones: logout-all cierra todo; el reseteo por admin cierra las del usuario', { skip }, async () => {
  const { api, pool } = S;
  const { token, password } = await registrar(api, 's2@test.local');
  const t2 = (await api('POST', '/api/auth/login', { body: { email: 's2@test.local', password } })).data.token;
  assert.equal((await api('POST', '/api/auth/logout-all', { token })).status, 200);
  assert.equal((await api('GET', '/api/machines', { token })).data.code, 'SESSION_REVOKED');
  assert.equal((await api('GET', '/api/machines', { token: t2 })).data.code, 'SESSION_REVOKED');

  const t3 = (await api('POST', '/api/auth/login', { body: { email: 's2@test.local', password } })).data.token;
  const admin = await registrar(api, 'admin@test.local');
  await pool.query('UPDATE users SET is_admin = true WHERE email = $1', ['admin@test.local']);
  const uid = (await pool.query('SELECT id FROM users WHERE email = $1', ['s2@test.local'])).rows[0].id;
  // Un usuario comun no puede resetear
  assert.equal((await api('POST', '/api/admin/reset-password', { body: { user_id: uid, new_password: 'zzzzzz' }, token: t3 })).status, 403);
  assert.equal((await api('POST', '/api/admin/reset-password', { body: { user_id: uid, new_password: 'zzzzzz' }, token: admin.token })).status, 200);
  assert.equal((await api('GET', '/api/machines', { token: t3 })).data.code, 'SESSION_REVOKED');
  assert.equal((await api('GET', '/api/machines', { token: admin.token })).status, 200, 'el admin sigue adentro');
});

// ================= MONITORES WEB =================
test('monitores: no se guardan destinos internos, ni al crear, ni al editar, ni por pending-changes', { skip }, async () => {
  const { api, pool } = S;
  const duenio = await registrar(api, 'u1@test.local');
  for (const url of ['http://127.0.0.1:5432/', 'http://localhost/', 'http://169.254.169.254/', 'http://[::1]/', 'http://10.0.0.1/', 'ftp://example.com/', 'file:///etc/passwd']) {
    const r = await api('POST', '/api/url-monitors', { body: { url, name: 'x' }, token: duenio.token });
    assert.equal(r.status, 400, url);
  }
  // Uno valido por IP publica literal (no toca DNS ni hace request al crear)
  const ok = await api('POST', '/api/url-monitors', { body: { url: 'https://93.184.216.34/', name: 'ok' }, token: duenio.token });
  assert.equal(ok.status, 200);
  const edit = await api('PUT', '/api/url-monitors/' + ok.data.id, { body: { url: 'http://192.168.1.1/' }, token: duenio.token });
  assert.equal(edit.status, 400);
  assert.equal((await pool.query('SELECT url FROM url_monitors WHERE id = $1', [ok.data.id])).rows[0].url, 'https://93.184.216.34/');

  // Un tecnico con la URL compartida propone cambiarla a un destino interno
  const tecnico = await registrar(api, 'tec@test.local');
  await pool.query('INSERT INTO url_shares (url_id, user_id, shared_by) VALUES ($1, $2, $3)', [ok.data.id, tecnico.user.id, duenio.user.id]);
  const pc = await api('POST', '/api/pending-changes', { body: { change_type: 'edit', target_type: 'url', target_id: ok.data.id, target_name: 'ok', data: { url: 'http://127.0.0.1:3000/admin' } }, token: tecnico.token });
  assert.equal(pc.status, 200);
  const aprob = await api('POST', '/api/pending-changes/' + pc.data.id + '/approve', { token: duenio.token });
  assert.equal(aprob.status, 400);
  assert.match(aprob.data.error, /no permitido|no publica|localhost/i);
  assert.equal((await pool.query('SELECT url FROM url_monitors WHERE id = $1', [ok.data.id])).rows[0].url, 'https://93.184.216.34/');
  assert.equal((await pool.query('SELECT status FROM pending_changes WHERE id = $1', [pc.data.id])).rows[0].status, 'rejected');
});

// ================= COMANDOS REMOTOS =================
test('comandos: la reserva es atomica entre latidos solapados y el resultado es idempotente', { skip }, async () => {
  const { api, pool } = S;
  const { token } = await registrar(api, 'c1@test.local');
  const { machineId, machineKey } = await vincular(api, token);
  await api('POST', '/api/machines/' + machineId + '/command', { body: { command: 'echo uno' }, token });
  await api('POST', '/api/machines/' + machineId + '/command', { body: { command: 'echo dos' }, token });

  // Dos latidos a la vez: cada comando debe llegar a UNO solo
  const [a, b] = await Promise.all([latido(api, machineKey), latido(api, machineKey)]);
  const ids = [...a.data.commands, ...b.data.commands].map(c => c.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, 'ningun comando entregado dos veces');
  // Y en el siguiente latido no se vuelven a ofrecer
  assert.deepEqual((await latido(api, machineKey)).data.commands, []);
  const filas = (await pool.query('SELECT status, delivery_count FROM remote_commands ORDER BY id')).rows;
  assert.deepEqual(filas, [{ status: 'delivered', delivery_count: 1 }, { status: 'delivered', delivery_count: 1 }]);

  // Cada comando viene firmado con la machine_key
  const cmd = [...a.data.commands, ...b.data.commands][0];
  assert.equal(cmd.sig, firmar(machineKey, 'cmd', String(cmd.id), cmd.command));

  // Resultado: la primera vez aplica, el reenvio no pisa ni falla
  const r1 = await api('POST', '/api/command-result', { body: { machine_key: machineKey, command_id: cmd.id, status: 'completed', output: 'uno\n' } });
  assert.equal(r1.status, 200); assert.equal(r1.data.aplicado, true);
  const r2 = await api('POST', '/api/command-result', { body: { machine_key: machineKey, command_id: cmd.id, status: 'failed', output: 'otra cosa' } });
  assert.equal(r2.status, 200); assert.equal(r2.data.aplicado, false);
  const fila = (await pool.query('SELECT status, output FROM remote_commands WHERE id = $1', [cmd.id])).rows[0];
  assert.deepEqual(fila, { status: 'completed', output: 'uno\n' });

  // Estado indeterminado se registra tal cual
  const otro = ids.find(i => i !== cmd.id);
  await api('POST', '/api/command-result', { body: { machine_key: machineKey, command_id: otro, status: 'indeterminate', output: '[INDETERMINADO]' } });
  assert.equal((await pool.query('SELECT status FROM remote_commands WHERE id = $1', [otro])).rows[0].status, 'indeterminate');
  // Ya resuelto: no vuelve a "pending" ni se reentrega
  assert.deepEqual((await latido(api, machineKey)).data.commands, []);
});

test('comandos: otra maquina no puede informar resultados ajenos, ni un usuario encolar en maquina ajena', { skip }, async () => {
  const { api, pool } = S;
  const u1 = await registrar(api, 'c2@test.local');
  const u2 = await registrar(api, 'c3@test.local');
  const m1 = await vincular(api, u1.token, 'm1');
  const m2 = await vincular(api, u2.token, 'm2');
  assert.equal((await api('POST', '/api/machines/' + m1.machineId + '/command', { body: { command: 'whoami' }, token: u2.token })).status, 404);
  await api('POST', '/api/machines/' + m1.machineId + '/command', { body: { command: 'whoami' }, token: u1.token });
  const cmd = (await latido(api, m1.machineKey)).data.commands[0];
  const ajeno = await api('POST', '/api/command-result', { body: { machine_key: m2.machineKey, command_id: cmd.id, output: 'pwned' } });
  assert.equal(ajeno.status, 404);
  assert.equal((await pool.query('SELECT status FROM remote_commands WHERE id = $1', [cmd.id])).rows[0].status, 'delivered');
});
