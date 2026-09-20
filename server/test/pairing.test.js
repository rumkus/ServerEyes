const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PairingStore } = require('../lib/pairing');

function store(opts = {}) {
  let t = 1_000_000;
  const s = new PairingStore({ now: () => t, ...opts });
  s.avanzar = (ms) => { t += ms; };
  return s;
}
const crearMaquina = async (p) => ({ id: 1, machine_name: p.machine_name, machine_key: 'CLAVE-' + p.machine_name });

test('request devuelve codigo de 6 digitos y token largo aleatorio', () => {
  const s = store();
  const r = s.request({ machine_name: 'pc1' });
  assert.match(r.code, /^\d{6}$/);
  assert.match(r.pairing_token, /^[0-9a-f]{64}$/);
  const r2 = s.request({ machine_name: 'pc2' });
  assert.notEqual(r.pairing_token, r2.pairing_token);
});

test('status sin token o con token ajeno no revela nada; con el token correcto retira la clave', async () => {
  const s = store();
  const { code, pairing_token } = s.request({ machine_name: 'pc1' });
  assert.equal(s.status({ code, token: '' }).status, 401);
  assert.equal(s.status({ code, token: 'x'.repeat(64) }).status, 401);
  // Todavia no confirmado: con el token correcto, confirmed=false y nada mas
  assert.deepEqual(s.status({ code, token: pairing_token }), { confirmed: false });

  const c = await s.confirm({ code, userId: 7, crearMaquina });
  assert.equal(c.machine.machine_key, 'CLAVE-pc1');

  // Un tercero que conoce el codigo (lo vio en pantalla) no puede llevarse la clave
  const ajeno = s.status({ code, token: 'a'.repeat(64) });
  assert.equal(ajeno.status, 401);
  assert.equal(ajeno.machine_key, undefined);

  const ok = s.status({ code, token: pairing_token });
  assert.deepEqual(ok, { confirmed: true, machine_key: 'CLAVE-pc1' });
});

test('mas de cinco respuestas perdidas: el mismo token sigue recuperando la clave; el codigo solo, no', async () => {
  const s = store();
  const { code, pairing_token } = s.request({ machine_name: 'pc1' });
  await s.confirm({ code, userId: 1, crearMaquina });
  // Ocho respuestas "perdidas" seguidas (el servidor las envio, el agente no las vio)
  for (let i = 0; i < 8; i++) assert.equal(s.status({ code, token: pairing_token }).machine_key, 'CLAVE-pc1', 'lectura ' + (i + 1));
  // Entre medio, alguien con el codigo pero sin el token no consigue nada
  assert.equal(s.status({ code, token: 'c'.repeat(64) }).status, 401);
  assert.equal(s.status({ code, token: '' }).status, 401);
  // Y la recuperacion posterior sigue funcionando
  assert.equal(s.status({ code, token: pairing_token }).machine_key, 'CLAVE-pc1');
});

test('la frecuencia de consultas por codigo tiene tope propio (429) y no anula el codigo', async () => {
  const s = store({ maxStatusPorMinuto: 10 });
  const { code, pairing_token } = s.request({ machine_name: 'pc1' });
  await s.confirm({ code, userId: 1, crearMaquina });
  for (let i = 0; i < 10; i++) assert.equal(s.status({ code, token: pairing_token }).confirmed, true);
  assert.equal(s.status({ code, token: pairing_token }).status, 429);
  // Pasado el minuto, el mismo token recupera la clave: el codigo sigue vivo
  s.avanzar(60 * 1000 + 1);
  assert.equal(s.status({ code, token: pairing_token }).machine_key, 'CLAVE-pc1');
});

test('la recuperacion esta acotada en el tiempo: vencido el codigo, ni el token la retira', async () => {
  const s = store();
  const { code, pairing_token } = s.request({ machine_name: 'pc1' });
  s.avanzar(4 * 60 * 1000 + 50 * 1000); // 4:50, confirma a ultimo momento
  await s.confirm({ code, userId: 1, crearMaquina });
  s.avanzar(60 * 1000); // 5:50: paso el TTL original, pero rige la gracia de 2 min
  assert.equal(s.status({ code, token: pairing_token }).machine_key, 'CLAVE-pc1');
  s.avanzar(2 * 60 * 1000); // 7:50: paso la gracia
  assert.equal(s.status({ code, token: pairing_token }).status, 404, 'vencido: ni el token valido lo recupera');
  assert.equal(s.status({ code, token: 'z'.repeat(64) }).status, 404);
});

test('tokens equivocados (muchos) no anulan el codigo ni gastan el cupo del agente legitimo', async () => {
  const s = store({ maxTokenFailsPorMinuto: 10, maxStatusPorMinuto: 5 });
  const { code, pairing_token } = s.request({ machine_name: 'pc1' });
  await s.confirm({ code, userId: 1, crearMaquina });
  // Alguien que vio el codigo en pantalla prueba 50 tokens: 401 hasta el
  // limite, despues 429 para ESAS consultas. Nunca 404.
  const respuestas = [];
  for (let i = 0; i < 50; i++) respuestas.push(s.status({ code, token: 'b'.repeat(64) }).status);
  assert.deepEqual([...new Set(respuestas)].sort(), [401, 429]);
  assert.equal(respuestas.filter(x => x === 401).length, 10);
  assert.ok(!respuestas.includes(404));
  // El agente legitimo retira la clave igual, con su propio cupo intacto
  for (let i = 0; i < 5; i++) assert.equal(s.status({ code, token: pairing_token }).machine_key, 'CLAVE-pc1', 'lectura legitima ' + (i + 1));
  // Su propio limite de frecuencia sigue existiendo, y no anula
  assert.equal(s.status({ code, token: pairing_token }).status, 429);
  s.avanzar(60 * 1000 + 1);
  assert.equal(s.status({ code, token: pairing_token }).machine_key, 'CLAVE-pc1');
  // Y el vencimiento manda sobre todo lo demas
  s.avanzar(10 * 60 * 1000);
  assert.equal(s.status({ code, token: pairing_token }).status, 404);
  assert.equal(s.status({ code, token: 'b'.repeat(64) }).status, 404);
});

test('el codigo vence a los 5 minutos', async () => {
  const s = store();
  const { code, pairing_token } = s.request({ machine_name: 'pc1' });
  s.avanzar(5 * 60 * 1000 + 1);
  assert.equal(s.status({ code, token: pairing_token }).status, 404);
  assert.equal((await s.confirm({ code, userId: 1, crearMaquina })).status, 404);
});

test('confirmaciones concurrentes crean UNA sola maquina', async () => {
  const s = store();
  const { code } = s.request({ machine_name: 'pc1' });
  let creadas = 0;
  const lenta = async (p) => { creadas++; await new Promise(r => setTimeout(r, 20)); return crearMaquina(p); };
  const [a, b, c] = await Promise.all([
    s.confirm({ code, userId: 1, crearMaquina: lenta }),
    s.confirm({ code, userId: 2, crearMaquina: lenta }),
    s.confirm({ code, userId: 1, crearMaquina: lenta })
  ]);
  assert.equal(creadas, 1);
  const exitos = [a, b, c].filter(r => r.machine);
  const rechazos = [a, b, c].filter(r => r.status === 409);
  assert.equal(exitos.length, 1);
  assert.equal(rechazos.length, 2);
});

test('si crearMaquina falla, el codigo vuelve a estar disponible', async () => {
  const s = store();
  const { code } = s.request({ machine_name: 'pc1' });
  await assert.rejects(s.confirm({ code, userId: 1, crearMaquina: async () => { throw new Error('db caida'); } }));
  const r = await s.confirm({ code, userId: 1, crearMaquina });
  assert.ok(r.machine);
});

test('un usuario que prueba codigos al azar queda frenado', async () => {
  const s = store({ maxConfirmFails: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await s.confirm({ code: '000000', userId: 9, crearMaquina })).status, 404);
  assert.equal((await s.confirm({ code: '000000', userId: 9, crearMaquina })).status, 429);
  // Otro usuario no esta afectado
  assert.equal((await s.confirm({ code: '000000', userId: 10, crearMaquina })).status, 404);
  // Y el freno se levanta al pasar la ventana
  s.avanzar(10 * 60 * 1000 + 1);
  assert.equal((await s.confirm({ code: '000000', userId: 9, crearMaquina })).status, 404);
});

test('limite de pedidos por IP', () => {
  const s = store({ maxRequestsPerIp: 2 });
  assert.ok(s.request({ machine_name: 'a', ip: '1.1.1.1' }).code);
  assert.ok(s.request({ machine_name: 'b', ip: '1.1.1.1' }).code);
  assert.equal(s.request({ machine_name: 'c', ip: '1.1.1.1' }).status, 429);
  assert.ok(s.request({ machine_name: 'd', ip: '2.2.2.2' }).code);
});
