// TRUST_PROXY=0: configuracion para correr SIN proxy delante (local, otro
// hosting). Con eso X-Forwarded-For se ignora por completo: req.ip es la IP
// del socket, y un cliente no puede fabricarse cupos nuevos con la cabecera.
//
// Topologia que simula: el cliente conecta DIRECTO al servidor (aca, desde
// 127.0.0.1) y escribe lo que quiera en X-Forwarded-For.
process.env.TRUST_PROXY = '0';
process.env.PAIRING_MAX_POR_IP = '5';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, levantarServer } = require('./helpers');

const skip = !hayBase() ? 'TEST_DATABASE_URL no definida: se salta la integracion' : false;

let S;
before(async () => { if (!skip) S = await levantarServer(); });
after(async () => { if (S) { await S.limpiar(); await S.cerrar(); } });

test('sin proxy (TRUST_PROXY=0): X-Forwarded-For se ignora y el limite por IP es el del socket', { skip }, async () => {
  const { api } = S;
  const pedir = (xff) => api('POST', '/api/pairing/request', { body: { machine_name: 'pc' }, headers: xff ? { 'X-Forwarded-For': xff } : {} });
  // Cinco pedidos "desde IPs distintas" segun la cabecera falsificada...
  for (let i = 0; i < 5; i++) assert.equal((await pedir(`203.0.113.${i}`)).status, 200);
  // ...y el sexto cae igual: todos cuentan para 127.0.0.1
  assert.equal((await pedir('203.0.113.99')).status, 429);
  assert.equal((await pedir('1.2.3.4, 5.6.7.8')).status, 429);
  assert.equal((await pedir(null)).status, 429);
});
