// Segunda tanda de integracion (TEST_DATABASE_URL): compatibilidad con agentes
// viejos, perdida de respuestas, reenvio manual, X-Forwarded-For, SSL.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, levantarServer, registrar } = require('./helpers');

const skip = !hayBase() ? 'TEST_DATABASE_URL no definida: se salta la integracion' : false;

let S;
before(async () => { if (!skip) S = await levantarServer(); });
after(async () => { if (S) { await S.limpiar(); await S.cerrar(); } });
beforeEach(async () => { if (S) await S.limpiar(); });

async function vincular(api, token, nombre = 'pc-test') {
  const req = await api('POST', '/api/pairing/request', { body: { machine_name: nombre, os_info: 'test' } });
  const conf = await api('POST', '/api/pairing/confirm', { body: { code: req.data.code }, token });
  assert.equal(conf.status, 200);
  const st = await api('GET', '/api/pairing/status/' + req.data.code, { headers: { 'X-Pairing-Token': req.data.pairing_token } });
  assert.equal(st.data.confirmed, true);
  return { machineId: conf.data.machine.id, machineKey: st.data.machine_key };
}
// Latido de un agente VIEJO (1.3.x): mismo body de siempre
const latidoViejo = (api, machineKey) => api('POST', '/api/heartbeat', { body: { machine_key: machineKey, machine_name: 'pc-test', public_ip: '203.0.113.5', local_ip: '10.0.0.2', os_info: 'test', agent_version: '1.3.7', agent_type: 'agent' } });
const encolar = (api, token, machineId, command) => api('POST', '/api/machines/' + machineId + '/command', { body: { command }, token });
let _k = 0;
const clave = () => 'confirmacion-' + (++_k) + '-' + Date.now().toString(36);
const reintentar = (api, token, id, key) => api('POST', '/api/commands/' + id + '/retry', { token, headers: { 'Idempotency-Key': key } });
const estado = async (pool, id) => (await pool.query('SELECT status, output, delivery_count FROM remote_commands WHERE id = $1', [id])).rows[0];

// ================= COMPATIBILIDAD: AGENTE VIEJO =================
test('agente viejo: recibe el comando firmado, manda solo output (sin status) y queda completed', { skip }, async () => {
  const { api, pool } = S;
  const { token } = await registrar(api, 'v1@test.local');
  const { machineId, machineKey } = await vincular(api, token);
  await encolar(api, token, machineId, 'echo viejo');
  const hb = await latidoViejo(api, machineKey);
  assert.equal(hb.status, 200);
  assert.equal(hb.data.commands.length, 1);
  const cmd = hb.data.commands[0];
  assert.ok(cmd.sig, 'la firma sigue viajando: el agente viejo la verifica igual');
  // El agente viejo no manda "status"
  const r = await api('POST', '/api/command-result', { body: { machine_key: machineKey, command_id: cmd.id, output: 'viejo\n' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await estado(pool, cmd.id), { status: 'completed', output: 'viejo\n', delivery_count: 1 });
});

test('agente viejo: si repite el envio del resultado (sin dedupe propio), el servidor no lo rompe', { skip }, async () => {
  const { api, pool } = S;
  const { token } = await registrar(api, 'v2@test.local');
  const { machineId, machineKey } = await vincular(api, token);
  await encolar(api, token, machineId, 'echo x');
  const cmd = (await latidoViejo(api, machineKey)).data.commands[0];
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', '/api/command-result', { body: { machine_key: machineKey, command_id: cmd.id, output: 'x' + i } });
    assert.equal(r.status, 200);
  }
  assert.equal((await estado(pool, cmd.id)).output, 'x0', 'el primero manda');
});

// ================= PERDIDA DE LA RESPUESTA DEL HEARTBEAT =================
test('respuesta del heartbeat perdida: el comando queda "delivered", no se reofrece, y solo el usuario lo reenvia', { skip }, async () => {
  const { api, pool } = S;
  const { token } = await registrar(api, 'h1@test.local');
  const { machineId, machineKey } = await vincular(api, token);
  const c = await encolar(api, token, machineId, 'shutdown /r');
  // El servidor reserva y responde; simulamos que la respuesta no llego al agente:
  await latidoViejo(api, machineKey);
  // Latidos siguientes: NO se vuelve a ofrecer (podria haberse ejecutado)
  for (let i = 0; i < 3; i++) assert.deepEqual((await latidoViejo(api, machineKey)).data.commands, []);
  assert.deepEqual(await estado(pool, c.data.id), { status: 'delivered', output: null, delivery_count: 1 });

  // El usuario decide reenviarlo: comando NUEVO con id nuevo, el original queda como historia
  const otro = await registrar(api, 'h2@test.local');
  assert.equal((await reintentar(api, otro.token, c.data.id, clave())).status, 404, 'solo el dueño');
  assert.equal((await api('POST', '/api/commands/' + c.data.id + '/retry', { token })).status, 400, 'sin Idempotency-Key no se acepta');
  const re = await reintentar(api, token, c.data.id, clave());
  assert.equal(re.status, 200);
  assert.notEqual(re.data.id, c.data.id);
  assert.equal(re.data.retry_of, c.data.id);
  assert.equal(re.data.command, 'shutdown /r');
  const hb = await latidoViejo(api, machineKey);
  assert.deepEqual(hb.data.commands.map(x => x.id), [re.data.id]);
  assert.equal((await estado(pool, c.data.id)).status, 'delivered', 'el original no cambia');
  // Un comando completado no se puede "reenviar" por esta via
  await api('POST', '/api/command-result', { body: { machine_key: machineKey, command_id: re.data.id, status: 'completed', output: 'ok' } });
  assert.equal((await reintentar(api, token, re.data.id, clave())).status, 409);
  // Queda en la auditoria, con el original y el nuevo
  const aud = await pool.query("SELECT target_type, target_id, details FROM audit_log WHERE action = 'remote_command_retry'");
  assert.equal(aud.rows.length, 1);
  assert.equal(aud.rows[0].target_id, re.data.id);
  assert.match(aud.rows[0].details, new RegExp('reenvio de #' + c.data.id));
});

test('reintento: la misma clave devuelve el mismo comando aunque ya este delivered o completed', { skip }, async () => {
  const { api, pool } = S;
  const { token } = await registrar(api, 'h3@test.local');
  const { machineId, machineKey } = await vincular(api, token);
  const c = await encolar(api, token, machineId, 'echo dup');
  await latidoViejo(api, machineKey); // original queda delivered
  const k = clave(); // 1. el usuario confirma UNA vez
  const primero = await reintentar(api, token, c.data.id, k); // 2. el servidor crea el comando
  assert.equal(primero.status, 200);
  assert.notEqual(primero.data.duplicado, true);
  const hb = await latidoViejo(api, machineKey); // 3. el agente lo retira: delivered
  assert.deepEqual(hb.data.commands.map(x => x.id), [primero.data.id]);
  // 4. la respuesta HTTP original "se perdio"; 5. el panel reintenta con la misma clave
  const otraVez = await reintentar(api, token, c.data.id, k);
  assert.equal(otraVez.status, 200);
  assert.equal(otraVez.data.id, primero.data.id);
  assert.equal(otraVez.data.duplicado, true);
  assert.equal(otraVez.data.status, 'delivered');
  // Incluso con el reenvio ya completed
  await api('POST', '/api/command-result', { body: { machine_key: machineKey, command_id: primero.data.id, status: 'completed', output: 'dup' } });
  const yaTerminado = await reintentar(api, token, c.data.id, k);
  assert.equal(yaTerminado.data.id, primero.data.id);
  assert.equal(yaTerminado.data.status, 'completed');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM remote_commands WHERE retry_of = $1', [c.data.id])).rows[0].n, 1, 'un solo comando nuevo');
  // Una confirmacion nueva (otra clave) SI crea otro: es lo que el usuario pidio
  const deliberado = await reintentar(api, token, c.data.id, clave());
  assert.equal(deliberado.status, 200);
  assert.notEqual(deliberado.data.id, primero.data.id);
  assert.notEqual(deliberado.data.duplicado, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM remote_commands WHERE retry_of = $1', [c.data.id])).rows[0].n, 2);
  // La clave es por usuario y por original: la misma clave sobre OTRO original crea otro comando
  const c2 = await encolar(api, token, machineId, 'echo otro');
  await latidoViejo(api, machineKey);
  const sobreOtro = await reintentar(api, token, c2.data.id, k);
  assert.equal(sobreOtro.status, 200);
  assert.notEqual(sobreOtro.data.id, primero.data.id);
  assert.notEqual(sobreOtro.data.duplicado, true);
});

test('reintento: si el original pasa a completed entre la confirmacion y el reintento, la misma clave devuelve el comando creado (no 409)', { skip }, async () => {
  const { api, pool } = S;
  const { token } = await registrar(api, 'h5@test.local');
  const { machineId, machineKey } = await vincular(api, token);
  const c = await encolar(api, token, machineId, 'echo tarde');
  await latidoViejo(api, machineKey); // original delivered
  const k = clave();
  const primero = await reintentar(api, token, c.data.id, k);
  assert.equal(primero.status, 200);
  // El agente, tarde, informa el ORIGINAL: ya no esta en un estado reenviable
  await api('POST', '/api/command-result', { body: { machine_key: machineKey, command_id: c.data.id, status: 'completed', output: 'llego tarde' } });
  assert.equal((await pool.query('SELECT status FROM remote_commands WHERE id = $1', [c.data.id])).rows[0].status, 'completed');
  // El panel reintenta la misma peticion (respuesta perdida): mismo comando, no 409
  const otraVez = await reintentar(api, token, c.data.id, k);
  assert.equal(otraVez.status, 200);
  assert.equal(otraVez.data.id, primero.data.id);
  assert.equal(otraVez.data.duplicado, true);
  // Una confirmacion NUEVA sobre un original completed si da 409
  assert.equal((await reintentar(api, token, c.data.id, clave())).status, 409);
  // Y otro usuario con la misma clave no ve nada (autorizacion antes que idempotencia)
  const otro = await registrar(api, 'h6@test.local');
  assert.equal((await reintentar(api, otro.token, c.data.id, k)).status, 404);
});

test('reintento: concurrencia con la misma clave crea exactamente un comando; claves distintas, uno cada una', { skip }, async () => {
  const { api, pool } = S;
  const { token } = await registrar(api, 'h4@test.local');
  const { machineId, machineKey } = await vincular(api, token);
  const c = await encolar(api, token, machineId, 'echo conc');
  await latidoViejo(api, machineKey);
  const k = clave();
  const rs = await Promise.all([0, 1, 2, 3, 4].map(() => reintentar(api, token, c.data.id, k)));
  assert.ok(rs.every(r => r.status === 200), JSON.stringify(rs.map(r => r.status)));
  assert.equal(new Set(rs.map(r => r.data.id)).size, 1, 'todos reciben el mismo id');
  assert.equal(rs.filter(r => !r.data.duplicado).length, 1, 'exactamente uno lo creo');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM remote_commands WHERE retry_of = $1', [c.data.id])).rows[0].n, 1);
  // Dos confirmaciones distintas al mismo tiempo: dos comandos
  const [a, b] = await Promise.all([reintentar(api, token, c.data.id, clave()), reintentar(api, token, c.data.id, clave())]);
  assert.notEqual(a.data.id, b.data.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM remote_commands WHERE retry_of = $1', [c.data.id])).rows[0].n, 3);
  // Formato de clave invalido
  assert.equal((await reintentar(api, token, c.data.id, 'x')).status, 400);
  assert.equal((await reintentar(api, token, c.data.id, 'a'.repeat(65))).status, 400);
});

test('reinicio durante la ejecucion: el agente informa indeterminate y el servidor no lo repite', { skip }, async () => {
  const { api, pool } = S;
  const { token } = await registrar(api, 'r1@test.local');
  const { machineId, machineKey } = await vincular(api, token);
  const c = await encolar(api, token, machineId, 'format d:');
  const cmd = (await latidoViejo(api, machineKey)).data.commands[0];
  // (el agente se reinicia; al volver, su registro lo informa como indeterminado)
  await api('POST', '/api/command-result', { body: { machine_key: machineKey, command_id: cmd.id, status: 'indeterminate', output: '[INDETERMINADO] reinicio' } });
  assert.equal((await estado(pool, c.data.id)).status, 'indeterminate');
  assert.deepEqual((await latidoViejo(api, machineKey)).data.commands, []);
  // Reenviar es posible pero explicito
  assert.equal((await reintentar(api, token, c.data.id, clave())).status, 200);
});

// ================= PAIRING: RESPUESTA PERDIDA POR HTTP =================
test('pairing: si la respuesta con la clave se pierde, el mismo token la recupera; sin token, no', { skip }, async () => {
  const { api } = S;
  const { token } = await registrar(api, 'pp@test.local');
  const req = await api('POST', '/api/pairing/request', { body: { machine_name: 'pc' } });
  await api('POST', '/api/pairing/confirm', { body: { code: req.data.code }, token });
  const h = { 'X-Pairing-Token': req.data.pairing_token };
  const primera = await api('GET', '/api/pairing/status/' + req.data.code, { headers: h }); // "se pierde"
  const segunda = await api('GET', '/api/pairing/status/' + req.data.code, { headers: h }); // reintento
  assert.equal(segunda.status, 200);
  assert.equal(segunda.data.machine_key, primera.data.machine_key);
  assert.equal((await api('GET', '/api/pairing/status/' + req.data.code)).status, 401);
  assert.equal((await api('GET', '/api/pairing/status/' + req.data.code, { headers: { 'X-Pairing-Token': 'e'.repeat(64) } })).status, 401);
});

// ================= X-FORWARDED-FOR =================
test('con TRUST_PROXY=1 el limite por IP usa la direccion que agrega el proxy, no lo que escriba el cliente', { skip }, async () => {
  const { api } = S;
  // El proxy de Railway deja la IP real al FINAL de X-Forwarded-For. Un
  // cliente que falsifique la cabecera solo agrega entradas antes.
  const pedir = (xff) => api('POST', '/api/pairing/request', { body: { machine_name: 'pc' }, headers: { 'X-Forwarded-For': xff } });
  let ultimo;
  for (let i = 0; i < 20; i++) ultimo = await pedir(`10.${i}.${i}.${i}, 8.8.4.4, 198.51.100.77`);
  assert.equal(ultimo.status, 200);
  const bloqueado = await pedir('1.2.3.4, 198.51.100.77');
  assert.equal(bloqueado.status, 429, 'cambiar lo falsificado no evade el limite');
  const otraReal = await pedir('1.2.3.4, 198.51.100.78');
  assert.equal(otraReal.status, 200, 'otra IP real (la que pone el proxy) tiene su propio cupo');
});

// ================= DIAGNOSTICO DE PROXY =================
test('diag/proxy: solo admin; refleja la cabecera cruda y lo que req.ip decide con TRUST_PROXY', { skip }, async () => {
  const { api, pool } = S;
  const comun = await registrar(api, 'diag-comun@test.local');
  assert.equal((await api('GET', '/api/admin/diag/proxy', { token: comun.token })).status, 403);
  assert.equal((await api('GET', '/api/admin/diag/proxy')).status, 401);
  const admin = await registrar(api, 'diag-admin@test.local');
  await pool.query('UPDATE users SET is_admin = true WHERE email = $1', ['diag-admin@test.local']);
  // Con TRUST_PROXY=1 (default en el harness): un salto de confianza -> req.ip es la ULTIMA entrada
  const r = await api('GET', '/api/admin/diag/proxy', { token: admin.token, headers: { 'X-Forwarded-For': '203.0.113.5, 198.51.100.9' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.trust_proxy, '1');
  assert.equal(r.data.x_forwarded_for, '203.0.113.5, 198.51.100.9', 'la cabecera cruda se devuelve tal cual');
  assert.equal(r.data.ip, '198.51.100.9');
  assert.deepEqual(r.data.ips, ['198.51.100.9']);
  assert.match(r.data.socket, /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
  assert.equal(r.data.via_cloudflare, false);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(r.data).includes(admin.token), 'nunca devuelve el token');
});

// ================= SSL =================
test('ssl: ni ssl-check ni los monitores aceptan hosts que apuntan adentro', { skip }, async () => {
  const { api, pool } = S;
  const { token } = await registrar(api, 'ssl@test.local');
  for (const hostname of ['127.0.0.1', 'localhost', '10.0.0.1', '[::1]', '169.254.169.254']) {
    const r = await api('POST', '/api/ssl-check', { body: { hostname }, token });
    assert.equal(r.status, 400, hostname);
    assert.equal(r.data.status, 'error');
    const m = await api('POST', '/api/ssl-monitors', { body: { hostname }, token });
    assert.equal(m.status, 400, 'monitor ' + hostname);
  }
  // Un monitor guardado ANTES del filtro que apunte adentro: la edicion tambien lo rechaza
  const viejo = await pool.query("INSERT INTO ssl_monitors (user_id, hostname, name) VALUES ((SELECT id FROM users WHERE email='ssl@test.local'), '127.0.0.1', 'viejo') RETURNING id");
  const e = await api('PUT', '/api/ssl-monitors/' + viejo.rows[0].id, { body: { hostname: '10.0.0.5' }, token });
  assert.equal(e.status, 400);
  // Y editar campos inocuos ya no da 500 (placeholders corregidos)
  const ok = await api('PUT', '/api/ssl-monitors/' + viejo.rows[0].id, { body: { name: 'renombrado', alert_days: [7, 1] }, token });
  assert.equal(ok.status, 200);
  assert.equal((await pool.query('SELECT name FROM ssl_monitors WHERE id = $1', [viejo.rows[0].id])).rows[0].name, 'renombrado');
});
