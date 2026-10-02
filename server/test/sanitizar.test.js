// Saneo de U+0000 en el heartbeat. Parte pura (siempre corre) + heartbeat real
// contra PostgreSQL aislado (TEST_DATABASE_URL; si no hay, se salta).
// Usa un notificador SIMULADO: no manda push ni correos reales.
const { test } = require('node:test');
const assert = require('node:assert');
const { quitarNulos } = require('../lib/sanitizar');
const { hayBase, levantarServer, registrar } = require('./helpers');

const NUL = String.fromCharCode(0); // U+0000 sin escapes en el fuente

// ---------------- PURO ----------------
test('quitarNulos: strings normales y Unicode valido intactos', () => {
  assert.strictEqual(quitarNulos('hola mundo'), 'hola mundo');
  assert.strictEqual(quitarNulos('café ☕ 日本 ñandú'), 'café ☕ 日本 ñandú');
});
test('quitarNulos: quita U+0000 al medio y en los bordes', () => {
  assert.strictEqual(quitarNulos('Win' + NUL + '11'), 'Win11');
  assert.strictEqual(quitarNulos(NUL + 'x' + NUL), 'x');
});
test('quitarNulos: recursivo en objetos y arrays anidados', () => {
  const entrada = { a: 'x' + NUL + 'y', b: { c: ['p' + NUL, 'q'], d: 'ok' }, e: [{ f: NUL + 'z' }] };
  assert.deepStrictEqual(quitarNulos(entrada), { a: 'xy', b: { c: ['p', 'q'], d: 'ok' }, e: [{ f: 'z' }] });
});
test('quitarNulos: tipos no-string se preservan (numero, bool, null)', () => {
  assert.strictEqual(quitarNulos(42), 42);
  assert.strictEqual(quitarNulos(0), 0);
  assert.strictEqual(quitarNulos(true), true);
  assert.strictEqual(quitarNulos(null), null);
  assert.strictEqual(quitarNulos(undefined), undefined);
});
test('quitarNulos: limpia el nulo en claves de objeto', () => {
  const r = quitarNulos({ ['k' + NUL + 'ey']: 'v' + NUL });
  assert.deepStrictEqual(r, { key: 'v' });
});

// --- caso de borde: colision de claves tras quitar el nulo ---
test('quitarNulos: colision de claves -> gana la PRIMERA, sin sobrescritura silenciosa', () => {
  const entrada = {};
  entrada['a' + NUL] = 1; // se inserta primero
  entrada['a'] = 2;       // colisiona tras limpiar
  const r = quitarNulos(entrada);
  assert.deepStrictEqual(Object.keys(r), ['a'], 'una sola clave resultante');
  assert.strictEqual(r.a, 1, 'conserva la primera ocurrencia (no pisa con la segunda)');
});

// --- caso de borde: __proto__ no debe contaminar el prototipo ---
test('quitarNulos: clave __proto__ no contamina Object.prototype', () => {
  const malicioso = JSON.parse('{"__proto__":{"polluted":1},"ok":2}'); // JSON.parse -> propiedad propia
  const r = quitarNulos(malicioso);
  assert.strictEqual(({}).polluted, undefined, 'no se contamino Object.prototype');
  assert.strictEqual(r.ok, 2);
  assert.ok(Object.prototype.hasOwnProperty.call(r, '__proto__'), '__proto__ queda como propiedad propia');
  assert.strictEqual(Object.getPrototypeOf(r), Object.prototype, 'el prototipo de r no cambio');
});
test('quitarNulos: __proto__ con nulo en la clave tampoco contamina', () => {
  const mal = {};
  Object.defineProperty(mal, '__pro' + NUL + 'to__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
  const r = quitarNulos(mal);
  assert.strictEqual(({}).x, undefined, 'sin contaminacion');
  assert.ok(Object.prototype.hasOwnProperty.call(r, '__proto__'), 'clave saneada como propiedad propia');
});

// ---------------- HEARTBEAT REAL ----------------
test('heartbeat con U+0000: se acepta y actualiza last_heartbeat', { skip: !hayBase() && 'TEST_DATABASE_URL no definida' }, async (t) => {
  const S = await levantarServer();
  const { api, pool, limpiar, cerrar } = S;
  t.after(async () => { await cerrar(); });
  await limpiar();
  const u = await registrar(api, 'nul@t.test');
  const key = 'k-nul-' + Date.now();
  await pool.query(
    `INSERT INTO machines (user_id, machine_name, machine_key, geo_manual, is_online, last_heartbeat)
     VALUES ($1,$2,$3,true,false,$4)`,
    [u.user.id, 'srv-nul', key, new Date(Date.now() - 3600000)]
  );

  await t.test('con bytes nulos en campos representativos y anidados -> 200', async () => {
    const r = await api('POST', '/api/heartbeat', { body: {
      machine_key: key,
      public_ip: '1.2.3.4',
      os_info: 'Win' + NUL + '11',
      agent_logs: 'linea1' + NUL + 'linea2',
      services: [{ name: 'MSSQL' + NUL + 'SERVER', status: 'running' }],
      inventory: { cpu: 'Intel' + NUL + 'Xeon', discos: [{ modelo: 'SSD' + NUL }] },
    }});
    assert.strictEqual(r.status, 200, 'antes del fix esto daba 500 "invalid byte sequence 0x00"');

    const row = (await pool.query('SELECT os_info, agent_logs, services, inventory, last_heartbeat, is_online FROM machines WHERE machine_key=$1', [key])).rows[0];
    assert.strictEqual(row.os_info, 'Win11');
    assert.strictEqual(row.agent_logs, 'linea1linea2');
    assert.strictEqual(row.services[0].name, 'MSSQLSERVER');
    assert.strictEqual(row.inventory.cpu, 'IntelXeon');
    assert.strictEqual(row.inventory.discos[0].modelo, 'SSD');
    assert.ok(!JSON.stringify(row).includes(NUL), 'no quedo ningun U+0000 persistido');
    assert.strictEqual(row.is_online, true, 'quedo online');
    assert.ok(Date.now() - new Date(row.last_heartbeat).getTime() < 15000, 'last_heartbeat se actualizo');
  });

  await t.test('heartbeat valido con Unicode se acepta y preserva', async () => {
    const r = await api('POST', '/api/heartbeat', { body: { machine_key: key, public_ip: '1.2.3.4', os_info: 'Windows 11 · café ☕' } });
    assert.strictEqual(r.status, 200);
    const row = (await pool.query('SELECT os_info FROM machines WHERE machine_key=$1', [key])).rows[0];
    assert.strictEqual(row.os_info, 'Windows 11 · café ☕', 'Unicode valido intacto');
  });
});
