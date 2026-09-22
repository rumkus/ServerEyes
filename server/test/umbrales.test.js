// Validacion de umbrales de alerta (CPU/RAM/disco en %, ping en ms).
// Cubre edicion directa y creacion de pending-changes, valores invalidos y
// limites validos. Se salta si no hay TEST_DATABASE_URL (PostgreSQL aislado).
const { test } = require('node:test');
const assert = require('node:assert');
const { hayBase, levantarServer, registrar } = require('./helpers');

test('umbrales de alerta: validacion en la API', { skip: !hayBase() && 'TEST_DATABASE_URL no definida' }, async (t) => {
  const S = await levantarServer();
  const { api, pool, limpiar, cerrar } = S;
  t.after(async () => { await cerrar(); });
  await limpiar();

  const owner = await registrar(api, 'owner@umbral.test');
  const m = await pool.query(
    "INSERT INTO machines (user_id, machine_name, machine_key) VALUES ($1,$2,$3) RETURNING id",
    [owner.user.id, 'MP Casa', 'key-umbral-1']
  );
  const id = m.rows[0].id;
  const put = (body) => api('PUT', '/api/machines/' + id, { token: owner.token, body });
  const leer = async (col) => (await pool.query(`SELECT ${col} FROM machines WHERE id=$1`, [id])).rows[0][col];

  await t.test('rechaza CPU > 100 (400, sin guardar)', async () => {
    const r = await put({ alert_cpu: 128 });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error || '', /CPU/i);
  });
  await t.test('rechaza CPU negativo', async () => {
    assert.strictEqual((await put({ alert_cpu: -5 })).status, 400);
  });
  await t.test('rechaza no numerico', async () => {
    assert.strictEqual((await put({ alert_ram: 'abc' })).status, 400);
  });
  await t.test('rechaza booleano', async () => {
    assert.strictEqual((await put({ alert_disk: true })).status, 400);
  });
  await t.test('rechaza ping negativo', async () => {
    assert.strictEqual((await put({ alert_ping: -1 })).status, 400);
  });
  await t.test('acepta limites validos 0 y 100', async () => {
    const r = await put({ alert_cpu: 0, alert_ram: 100, alert_disk: 50 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await leer('alert_cpu'), 0);
    assert.strictEqual(await leer('alert_ram'), 100);
    assert.strictEqual(await leer('alert_disk'), 50);
  });
  await t.test('null deshabilita (guarda NULL)', async () => {
    const r = await put({ alert_cpu: null });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await leer('alert_cpu'), null);
  });
  await t.test('cadena vacia = deshabilitar (NULL), no error', async () => {
    await put({ alert_ram: 90 });
    const r = await put({ alert_ram: '' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await leer('alert_ram'), null);
  });
  await t.test('ping alto se acepta (ms, sin tope superior)', async () => {
    assert.strictEqual((await put({ alert_ping: 5000 })).status, 200);
    assert.strictEqual(await leer('alert_ping'), 5000);
  });
  await t.test('un valor invalido no aplica NINGUN cambio de esa request', async () => {
    await put({ alert_cpu: 42 });
    const r = await put({ alert_cpu: 77, alert_ram: 999 }); // ram invalido
    assert.strictEqual(r.status, 400);
    assert.strictEqual(await leer('alert_cpu'), 42);   // el 77 NO se aplico
  });
  await t.test('decimal valido se normaliza a entero (columna INTEGER)', async () => {
    const r = await put({ alert_cpu: 90.6 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await leer('alert_cpu'), 91);
  });

  await t.test('pending-change: umbral invalido rechazado al crear', async () => {
    const tech = await registrar(api, 'tech@umbral.test');
    await pool.query(
      "INSERT INTO machine_shares (machine_id, user_id, shared_by, can_edit) VALUES ($1,$2,$3,true)",
      [id, tech.user.id, owner.user.id]
    );
    const r = await api('POST', '/api/pending-changes', { token: tech.token, body: {
      change_type: 'edit', target_type: 'machine', target_id: id, target_name: 'MP Casa', data: { alert_cpu: 150 }
    }});
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error || '', /CPU/i);
  });
  await t.test('pending-change: umbral valido se crea (200/ok)', async () => {
    const tech2 = await registrar(api, 'tech2@umbral.test');
    await pool.query(
      "INSERT INTO machine_shares (machine_id, user_id, shared_by, can_edit) VALUES ($1,$2,$3,true)",
      [id, tech2.user.id, owner.user.id]
    );
    const r = await api('POST', '/api/pending-changes', { token: tech2.token, body: {
      change_type: 'edit', target_type: 'machine', target_id: id, target_name: 'MP Casa', data: { alert_cpu: 85 }
    }});
    assert.strictEqual(r.status, 200);
  });
});
