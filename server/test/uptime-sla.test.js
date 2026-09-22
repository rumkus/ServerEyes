// Uptime y SLA recortados a created_at: una maquina nueva no debe mostrar
// disponibilidad inventada en dias/meses anteriores a su alta. Corre contra
// PostgreSQL aislado (TEST_DATABASE_URL); si no hay, se salta.
const { test } = require('node:test');
const assert = require('node:assert');
const { hayBase, levantarServer, registrar } = require('./helpers');

const DIA = 86400000;
const claveUTC = (d) => new Date(d).toISOString().slice(0, 10);

async function crearMaquina(pool, userId, nombre, createdAt) {
  const r = await pool.query(
    "INSERT INTO machines (user_id, machine_name, machine_key, created_at) VALUES ($1,$2,$3,$4) RETURNING id",
    [userId, nombre, 'k-' + nombre + '-' + Date.now() + Math.random(), createdAt]
  );
  return r.rows[0].id;
}
async function evento(pool, machineId, status, ts) {
  await pool.query("INSERT INTO uptime_log (machine_id, status, timestamp) VALUES ($1,$2,$3)", [machineId, status, ts]);
}

test('uptime y SLA: recorte a created_at', { skip: !hayBase() && 'TEST_DATABASE_URL no definida' }, async (t) => {
  const S = await levantarServer();
  const { api, pool, limpiar, cerrar } = S;
  t.after(async () => { await cerrar(); });
  await limpiar();
  const u = await registrar(api, 'uptime@test.test');
  const now = Date.now();

  await t.test('maquina NUEVA (alta hoy, sin eventos): solo el dia de hoy, sin offline inventado', async () => {
    const created = new Date(now - 5 * 60000); // hace 5 min
    const id = await crearMaquina(pool, u.user.id, 'nueva', created);
    const r = await api('GET', `/api/machines/${id}/uptime?days=7`, { token: u.token });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.length, 1, 'solo debe devolver 1 dia (hoy)');
    assert.strictEqual(r.data[0].date, claveUTC(now));
    // sin registros aun, el lapso alta->primer latido es DESCONOCIDO: no se cuenta
    // ni como caida ni como disponibilidad (observado = 0).
    assert.strictEqual(r.data[0].offline_minutes, 0, 'el lapso desconocido no es caida');
    assert.strictEqual(r.data[0].online_minutes, 0);
    assert.strictEqual(r.data[0].total_minutes, 0, 'observado = 0 (todo desconocido)');
    assert.strictEqual(r.headers.get('x-uptime-overall'), '', 'sin tiempo observado, overall vacio');
  });

  await t.test('el lapso alta->primer registro queda DESCONOCIDO (ni caida ni disponibilidad)', async () => {
    const created = new Date(now - 2 * 3600 * 1000);            // alta hace 2 h
    const id = await crearMaquina(pool, u.user.id, 'gap', created);
    await evento(pool, id, 'online', new Date(now - 1 * 3600 * 1000)); // primer registro 1 h despues
    const r = await api('GET', `/api/machines/${id}/uptime?days=7`, { token: u.token });
    const obsTotal = r.data.reduce((a, d) => a + d.online_minutes + d.offline_minutes, 0);
    const offline = r.data.reduce((a, d) => a + d.offline_minutes, 0);
    const online = r.data.reduce((a, d) => a + d.online_minutes, 0);
    assert.strictEqual(offline, 0, 'la hora desconocida NO se cuenta como caida');
    assert.ok(Math.abs(online - 60) <= 2, 'solo la hora posterior al primer registro cuenta como disponibilidad, fue ' + online);
    assert.ok(Math.abs(obsTotal - 60) <= 2, 'observado ~60 min (excluye la hora desconocida), fue ' + obsTotal);
    assert.strictEqual(r.headers.get('x-uptime-overall'), '100', 'todo el observado fue online');
  });

  await t.test('maquina de hace 3 dias, online desde el alta: dias contiguos desde el alta, ninguno antes', async () => {
    const created = new Date(now - 3 * DIA);
    const id = await crearMaquina(pool, u.user.id, 'tresdias', created);
    await evento(pool, id, 'online', new Date(created.getTime() + 30000));
    const r = await api('GET', `/api/machines/${id}/uptime?days=7`, { token: u.token });
    assert.strictEqual(r.status, 200);
    const fechas = r.data.map(d => d.date);
    const minKey = claveUTC(created), maxKey = claveUTC(now);
    assert.strictEqual(fechas[0], minKey, 'el primer dia es el del alta');
    assert.strictEqual(fechas[fechas.length - 1], maxKey);
    // contiguo y sin dias previos al alta
    const esperados = Math.round((new Date(maxKey) - new Date(minKey)) / DIA) + 1;
    assert.strictEqual(r.data.length, esperados);
    assert.ok(fechas.every(f => f >= minKey), 'ningun dia anterior al alta');
    // dia del alta parcial
    assert.ok(r.data[0].total_minutes < 1440);
  });

  await t.test('overall = online/observado (no promedio de dias), y coincide con el header', async () => {
    const created = new Date(now - 2 * DIA);
    const id = await crearMaquina(pool, u.user.id, 'overall', created);
    await evento(pool, id, 'online', new Date(created.getTime() + 1000));
    await evento(pool, id, 'offline', new Date(now - 1 * DIA)); // cae hace 1 dia
    const r = await api('GET', `/api/machines/${id}/uptime?days=7`, { token: u.token });
    const dias = r.data;
    const sumOn = dias.reduce((a, d) => a + d.online_minutes, 0);
    const sumTot = dias.reduce((a, d) => a + d.online_minutes + d.offline_minutes, 0);
    const esperado = sumTot > 0 ? Math.round(sumOn / sumTot * 100) : null;
    assert.strictEqual(r.headers.get('x-uptime-overall'), esperado === null ? '' : String(esperado));
    // el promedio ingenuo de %s de dias distintos difiere del correcto: probamos
    // que el server NO uso el promedio de dias.
    const promDias = Math.round(dias.reduce((a, d) => a + d.percentage, 0) / dias.length);
    assert.notStrictEqual(esperado, undefined);
    // (no exigimos que difieran siempre, pero el overall debe ser el de minutos)
    assert.strictEqual(esperado, Math.round(sumOn / sumTot * 100));
  });

  await t.test('maquina vieja que cae: comportamiento normal, 7 dias', async () => {
    const created = new Date(now - 40 * DIA);
    const id = await crearMaquina(pool, u.user.id, 'vieja', created);
    await evento(pool, id, 'online', new Date(now - 40 * DIA));
    await evento(pool, id, 'offline', new Date(now - 2 * DIA));
    const r = await api('GET', `/api/machines/${id}/uptime?days=7`, { token: u.token });
    assert.strictEqual(r.data.length, 7);
    // hace 5 dias estaba 100% online
    const hace5 = r.data.find(d => d.date === claveUTC(now - 5 * DIA));
    assert.ok(hace5 && hace5.percentage === 100);
    // hoy esta 0% (cayo hace 2 dias y sigue offline)
    const hoy = r.data.find(d => d.date === claveUTC(now));
    assert.ok(hoy && hoy.percentage === 0);
  });

  await t.test('sin registros: no inventa disponibilidad previa al alta', async () => {
    const created = new Date(now - 2 * DIA);
    const id = await crearMaquina(pool, u.user.id, 'sinreg', created);
    const r = await api('GET', `/api/machines/${id}/uptime?days=30`, { token: u.token });
    // pidiendo 30 dias pero el alta fue hace 2: solo dias desde el alta
    assert.ok(r.data.length <= 3, 'no mas dias que los transcurridos desde el alta');
    assert.ok(r.data.every(d => d.date >= claveUTC(created)));
  });

  await t.test('SLA: maquina nueva -> solo el mes del alta, no 6 meses', async () => {
    const created = new Date(now - 5 * 60000);
    const id = await crearMaquina(pool, u.user.id, 'slanueva', created);
    const r = await api('GET', `/api/machines/${id}/sla`, { token: u.token });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.months.length, 1, 'solo el mes en curso (el del alta)');
    // periodo observado del mes = parcial (desde el alta), en horas es 0
    assert.ok(r.data.months[0].total_hours <= 1);
  });

  await t.test('SLA: maquina de hace ~40 dias -> a lo sumo 2 meses, ninguno previo al alta', async () => {
    const created = new Date(now - 40 * DIA);
    const id = await crearMaquina(pool, u.user.id, 'slavieja', created);
    await evento(pool, id, 'online', new Date(now - 40 * DIA));
    const r = await api('GET', `/api/machines/${id}/sla`, { token: u.token });
    assert.ok(r.data.months.length <= 2, 'no meses anteriores al alta');
  });
});
