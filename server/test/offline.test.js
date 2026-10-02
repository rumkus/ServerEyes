// Antirrebote del detector de offline. Parte pura (siempre corre) + ciclo
// completo contra PostgreSQL aislado (TEST_DATABASE_URL; si no hay, se salta).
// Usa un notificador SIMULADO: no manda push ni correos reales.
const { test } = require('node:test');
const assert = require('node:assert');
const offline = require('../lib/offline');
const { hayBase, levantarServer, registrar } = require('./helpers');

// ---------------- PURO (sin base) ----------------
test('clasificar: latido fresco no es offline ni alerta', () => {
  const r = offline.clasificar(new Date(Date.now() - 10 * 1000));
  assert.strictEqual(r.offline, false); assert.strictEqual(r.alertar, false);
});
test('clasificar: blip (90s) marca offline pero NO alerta (antirrebote)', () => {
  const r = offline.clasificar(new Date(Date.now() - 90 * 1000));
  assert.strictEqual(r.offline, true); assert.strictEqual(r.alertar, false);
});
test('clasificar: silencio sostenido (200s) marca offline Y alerta', () => {
  const r = offline.clasificar(new Date(Date.now() - 200 * 1000));
  assert.strictEqual(r.offline, true); assert.strictEqual(r.alertar, true);
});
test('clasificar: last_heartbeat nulo/invalido no dispara nada', () => {
  assert.deepStrictEqual(offline.clasificar(null), { offline: false, alertar: false, edadSeg: null });
  assert.deepStrictEqual(offline.clasificar('no-fecha'), { offline: false, alertar: false, edadSeg: null });
});
test('config validada: ALERT_SEG >= MARK_SEG y defaults 60/180', () => {
  assert.ok(offline.ALERT_SEG >= offline.MARK_SEG);
  assert.strictEqual(offline.MARK_SEG, 60);
  assert.strictEqual(offline.ALERT_SEG, 180);
});
test('clasificar: umbrales configurables por opts', () => {
  const edad = new Date(Date.now() - 45 * 1000);
  const r = offline.clasificar(edad, Date.now(), { markSeg: 30, alertSeg: 120 });
  assert.strictEqual(r.offline, true); assert.strictEqual(r.alertar, false);
});

// ---------------- CICLO COMPLETO (PostgreSQL) ----------------
function fakeNotificador() {
  const calls = []; let modo = 'ok';
  return {
    calls,
    fallar() { modo = 'fail'; }, ok() { modo = 'ok'; },
    async notificar(m) { calls.push(m.id); if (modo === 'fail') throw new Error('envio fallo (simulado)'); },
  };
}

test('ciclo offline: antirrebote end-to-end', { skip: !hayBase() && 'TEST_DATABASE_URL no definida' }, async (t) => {
  const S = await levantarServer();
  const { api, pool, limpiar, cerrar } = S;
  t.after(async () => { await cerrar(); });

  let seq = 0;
  const crear = async (userId, nombre, edadSeg, extra = {}) => {
    const key = 'k-' + nombre + '-' + (++seq) + '-' + Date.now();
    const r = await pool.query(
      `INSERT INTO machines (user_id, machine_name, machine_key, is_online, offline_notified, geo_manual, last_heartbeat)
       VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id`,
      [userId, nombre, key, extra.is_online !== false, extra.offline_notified === true, new Date(Date.now() - edadSeg * 1000)]
    );
    return { id: r.rows[0].id, key };
  };
  const estado = async (id) => (await pool.query('SELECT is_online, offline_notified FROM machines WHERE id=$1', [id])).rows[0];
  const incidentes = async (id, status) => (await pool.query('SELECT * FROM incidents WHERE machine_id=$1' + (status ? ' AND status=$2' : ''), status ? [id, status] : [id])).rows;
  const uptime = async (id) => (await pool.query('SELECT status FROM uptime_log WHERE machine_id=$1 ORDER BY timestamp', [id])).rows.map(r => r.status);

  await t.test('1) interrupcion breve: panel offline, sin aviso ni incidente', async () => {
    await limpiar(); const u = await registrar(api, 'a@t.test'); const fk = fakeNotificador();
    const m = await crear(u.user.id, 'blip', 90);
    await offline.evaluarOffline(pool, { notificar: fk.notificar });
    assert.strictEqual((await estado(m.id)).is_online, false, 'panel: offline');
    assert.strictEqual((await estado(m.id)).offline_notified, false, 'no se marco notificada');
    assert.deepStrictEqual(fk.calls, [], 'no se intento avisar');
    assert.strictEqual((await incidentes(m.id)).length, 0, 'sin incidente');
    assert.deepStrictEqual(await uptime(m.id), ['offline'], 'uptime registra la transicion (SLA sin cambios)');
  });

  await t.test('2) recuperacion breve: sin aviso de recuperacion (nunca se notifico)', async () => {
    await limpiar(); const u = await registrar(api, 'b@t.test'); const fk = fakeNotificador();
    const m = await crear(u.user.id, 'blip2', 90);
    await offline.evaluarOffline(pool, { notificar: fk.notificar });        // marca offline, no alerta
    const r = await api('POST', '/api/heartbeat', { body: { machine_key: m.key, public_ip: '1.2.3.4' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await estado(m.id)).is_online, true, 'vuelve online');
    assert.strictEqual((await incidentes(m.id)).length, 0, 'no hubo incidente que cerrar ni aviso');
  });

  await t.test('3) interrupcion sostenida: UNA alerta y UN incidente', async () => {
    await limpiar(); const u = await registrar(api, 'c@t.test'); const fk = fakeNotificador();
    const m = await crear(u.user.id, 'caida', 300);
    await offline.evaluarOffline(pool, { notificar: fk.notificar });
    assert.strictEqual((await estado(m.id)).offline_notified, true);
    assert.deepStrictEqual(fk.calls, [m.id], 'aviso una sola vez');
    assert.strictEqual((await incidentes(m.id, 'open')).length, 1, 'un incidente abierto');
    // segunda pasada sin recuperacion: no re-alerta ni duplica incidente
    await offline.evaluarOffline(pool, { notificar: fk.notificar });
    assert.deepStrictEqual(fk.calls, [m.id], 'no re-alerta');
    assert.strictEqual((await incidentes(m.id, 'open')).length, 1, 'no duplica incidente');
  });

  await t.test('4) recuperacion posterior: cierra el incidente (politica existente)', async () => {
    await limpiar(); const u = await registrar(api, 'd@t.test'); const fk = fakeNotificador();
    const m = await crear(u.user.id, 'caida2', 300);
    await offline.evaluarOffline(pool, { notificar: fk.notificar });
    assert.strictEqual((await incidentes(m.id, 'open')).length, 1);
    const r = await api('POST', '/api/heartbeat', { body: { machine_key: m.key, public_ip: '1.2.3.4' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await estado(m.id)).is_online, true);
    assert.strictEqual((await estado(m.id)).offline_notified, false, 'listo para la proxima');
    assert.strictEqual((await incidentes(m.id, 'open')).length, 0, 'incidente cerrado');
    assert.strictEqual((await incidentes(m.id, 'resolved')).length, 1, 'incidente resuelto');
  });

  await t.test('5) segunda caida: vuelve a alertar', async () => {
    await limpiar(); const u = await registrar(api, 'e@t.test'); const fk = fakeNotificador();
    const m = await crear(u.user.id, 'recurrente', 300);
    await offline.evaluarOffline(pool, { notificar: fk.notificar });                 // 1ra
    await api('POST', '/api/heartbeat', { body: { machine_key: m.key, public_ip: '1.2.3.4' } }); // recupera
    await pool.query('UPDATE machines SET last_heartbeat = $1 WHERE id = $2', [new Date(Date.now() - 300000), m.id]); // cae de nuevo
    await offline.evaluarOffline(pool, { notificar: fk.notificar });                 // 2da
    assert.deepStrictEqual(fk.calls, [m.id, m.id], 'alerto dos veces (dos caidas)');
    assert.strictEqual((await incidentes(m.id, 'open')).length, 1, 'un nuevo incidente');
    assert.strictEqual((await incidentes(m.id, 'resolved')).length, 1, 'el anterior quedo resuelto');
  });

  await t.test('6) detectores concurrentes: una sola alerta (reclamo atomico)', async () => {
    await limpiar(); const u = await registrar(api, 'f@t.test'); const fk = fakeNotificador();
    const m = await crear(u.user.id, 'concurrente', 300);
    await Promise.all([
      offline.evaluarOffline(pool, { notificar: fk.notificar }),
      offline.evaluarOffline(pool, { notificar: fk.notificar }),
    ]);
    assert.strictEqual(fk.calls.filter(x => x === m.id).length, 1, 'avisa una sola vez pese a dos detectores');
    assert.strictEqual((await incidentes(m.id, 'open')).length, 1, 'un solo incidente');
  });

  await t.test('7) reinicio durante la gracia: la gracia se mide por last_heartbeat (sobrevive)', async () => {
    await limpiar(); const u = await registrar(api, 'g@t.test'); const fk = fakeNotificador();
    // Estado tras reiniciar el server a mitad de la gracia: ya marcada offline,
    // aun no notificada, con el silencio ya sostenido.
    const m = await crear(u.user.id, 'post-reinicio', 300, { is_online: false, offline_notified: false });
    await offline.evaluarOffline(pool, { notificar: fk.notificar });
    assert.deepStrictEqual(fk.calls, [m.id], 'alerta igual: la gracia no depende de un timer en memoria');
  });

  await t.test('8) fallo del envio: no se pierde la alerta (revierte y reintenta, sin duplicar incidente)', async () => {
    await limpiar(); const u = await registrar(api, 'h@t.test'); const fk = fakeNotificador();
    const m = await crear(u.user.id, 'envio-falla', 300);
    fk.fallar();
    await offline.evaluarOffline(pool, { notificar: fk.notificar });
    assert.strictEqual((await estado(m.id)).offline_notified, false, 'revirtio: no quedo marcada como enviada');
    assert.strictEqual((await incidentes(m.id, 'open')).length, 1, 'el incidente se creo (caida real)');
    // reintento con el envio funcionando: alerta y NO duplica incidente
    fk.ok();
    await offline.evaluarOffline(pool, { notificar: fk.notificar });
    assert.strictEqual((await estado(m.id)).offline_notified, true, 'ahora si quedo notificada');
    assert.strictEqual((await incidentes(m.id, 'open')).length, 1, 'incidente idempotente (no duplicado)');
    assert.strictEqual(fk.calls.filter(x => x === m.id).length, 2, 'se intento 2 veces (fallo + reintento)');
  });

  await t.test('9) carrera detector/heartbeat: reclamo -> llega heartbeat y recupera -> el detector sigue; sin incidente abierto ni aviso, y puede alertar una caida posterior', async () => {
    await limpiar(); const u = await registrar(api, 'i@t.test'); const fk = fakeNotificador();
    const m = await crear(u.user.id, 'carrera', 300, { is_online: false });
    // El detector RECLAMA la caida (paso 2 atomico), aun sin procesarla.
    const claimed = await offline.reclamarOfflineSostenidas(pool);
    assert.ok(claimed.rows.some(r => r.id === m.id), 'la reclamo');
    assert.strictEqual((await estado(m.id)).offline_notified, true);
    // Llega un heartbeat y la recupera (online, offline_notified=false, resuelve incidentes).
    const hr = await api('POST', '/api/heartbeat', { body: { machine_key: m.key, public_ip: '1.2.3.4' } });
    assert.strictEqual(hr.status, 200);
    assert.strictEqual((await estado(m.id)).is_online, true, 'recuperada por el heartbeat');
    // El detector CONTINUA procesando la fila que ya tenia reclamada.
    const r = await offline.procesarSostenida(pool, claimed.rows.find(x => x.id === m.id), { notificar: fk.notificar });
    assert.strictEqual(r.omitida, true, 'se omite: ya estaba online');
    assert.deepStrictEqual(fk.calls, [], 'no avisa de una maquina recuperada');
    assert.strictEqual((await incidentes(m.id, 'open')).length, 0, 'no queda incidente abierto para una maquina recuperada');
    // Sigue pudiendo alertar una caida POSTERIOR.
    await pool.query('UPDATE machines SET is_online=false, offline_notified=false, last_heartbeat=$1 WHERE id=$2', [new Date(Date.now() - 300000), m.id]);
    await offline.evaluarOffline(pool, { notificar: fk.notificar });
    assert.deepStrictEqual(fk.calls, [m.id], 'alerta la caida posterior');
    assert.strictEqual((await incidentes(m.id, 'open')).length, 1, 'un incidente para la nueva caida');
  });

  await t.test('10) tras la recuperacion, una caida posterior cuyo aviso FALLA no se pierde (revierte y reintenta)', async () => {
    await limpiar(); const u = await registrar(api, 'j@t.test'); const fk = fakeNotificador();
    const m = await crear(u.user.id, 'carrera2', 300, { is_online: false });
    const claimed = await offline.reclamarOfflineSostenidas(pool);
    await api('POST', '/api/heartbeat', { body: { machine_key: m.key, public_ip: '1.2.3.4' } }); // recupera
    const r0 = await offline.procesarSostenida(pool, claimed.rows.find(x => x.id === m.id), { notificar: fk.notificar });
    assert.strictEqual(r0.omitida, true);
    // Caida posterior con el envio fallando:
    fk.fallar();
    await pool.query('UPDATE machines SET is_online=false, offline_notified=false, last_heartbeat=$1 WHERE id=$2', [new Date(Date.now() - 300000), m.id]);
    await offline.evaluarOffline(pool, { notificar: fk.notificar });
    assert.strictEqual((await estado(m.id)).offline_notified, false, 'revirtio: la alerta no se perdio');
    assert.strictEqual((await incidentes(m.id, 'open')).length, 1, 'incidente creado');
    // Reintento con el envio OK:
    fk.ok();
    await offline.evaluarOffline(pool, { notificar: fk.notificar });
    assert.strictEqual((await estado(m.id)).offline_notified, true, 'ahora si quedo notificada');
    assert.strictEqual((await incidentes(m.id, 'open')).length, 1, 'incidente idempotente (sin duplicar)');
  });
});
