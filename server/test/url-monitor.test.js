const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { followRedirects, validarDestino, DestinoNoPermitido } = require('../lib/url-guard');
const { evaluarSalud } = require('../lib/health-check');

// Integracion end-to-end del chequeo SIN tocar staging: un servidor HTTP local
// simula las respuestas (503, JSON malo, redireccion a login, timeout, sano) y
// se ejercita la cadena real `followRedirects` -> captura de cuerpo ->
// `evaluarSalud`. Como 127.0.0.1 NUNCA pasa el validador real (SSRF), se inyecta
// un validador de prueba que solo mapea "local.test" al servidor local y delega
// el resto al validador de verdad (igual que url-guard.test.js). No hay bypass
// en produccion: server.js nunca pasa `validar`.
let srv, port;
before(async () => {
  srv = http.createServer((req, res) => {
    if (req.url === '/ok-web')   { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok","service":"web"}'); }
    if (req.url === '/503')      { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"status":"error"}'); }
    if (req.url === '/badjson')  { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>mantenimiento</html>'); }
    if (req.url === '/degradado'){ res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"degraded","service":"web"}'); }
    if (req.url === '/tologin')  { res.writeHead(302, { Location: '/login' }); return res.end(); }
    if (req.url === '/login')    { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<form>login</form>'); }
    if (req.url === '/lento')    { setTimeout(() => { try { res.writeHead(200); res.end('{}'); } catch (e) {} }, 3000); return; }
    res.writeHead(404); res.end('nope');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
});
after(() => srv && srv.close());

const validarLocal = async (url) => {
  const u = new URL(url);
  if (u.hostname === 'local.test') return { url, hostname: 'local.test', address: '127.0.0.1', family: 4 };
  return validarDestino(url);
};

const specWeb = { expected_status: 200, expected_json: { status: 'ok', service: 'web' }, health_mode: true, enforce_tls: false };

// Hace el intento real y lo evalua, como probeUrl() en server.js.
async function probar(ruta, spec = specWeb, timeoutMs = 2000) {
  try {
    const r = await followRedirects('http://local.test:' + port + ruta, 'GET', timeoutMs, 5, { validar: validarLocal, captureBody: 65536 });
    return evaluarSalud({ status: r.status, body: r.body, finalUrl: r.finalUrl, redirects: r.redirects, tls: r.tls, error: null }, spec);
  } catch (err) {
    return evaluarSalud({ error: err }, spec);
  }
}

test('e2e sano: 200 + JSON esperado', async () => {
  const v = await probar('/ok-web');
  assert.deepEqual(v, { ok: true, kind: null, detail: null });
});

test('e2e 503 -> caida http', async () => {
  const v = await probar('/503');
  assert.equal(v.ok, false); assert.equal(v.kind, 'http'); assert.match(v.detail, /503/);
});

test('e2e JSON invalido -> caida json', async () => {
  const v = await probar('/badjson');
  assert.equal(v.ok, false); assert.equal(v.kind, 'json');
});

test('e2e JSON degradado -> caida json', async () => {
  const v = await probar('/degradado');
  assert.equal(v.ok, false); assert.equal(v.kind, 'json');
});

test('e2e redireccion a login -> caida redireccion (no sana)', async () => {
  const v = await probar('/tologin');
  assert.equal(v.ok, false); assert.equal(v.kind, 'redireccion');
});

test('e2e timeout (10s de timeout vs respuesta a 3s, con timeout corto) -> caida timeout', async () => {
  const v = await probar('/lento', specWeb, 800);
  assert.equal(v.ok, false); assert.equal(v.kind, 'timeout');
});

test('e2e recuperacion: la MISMA URL vuelve a estar sana', async () => {
  // simula caida -> arreglo: primero /503, despues /ok-web
  assert.equal((await probar('/503')).ok, false);
  assert.equal((await probar('/ok-web')).ok, true);
});

test('e2e captura de cuerpo acotada no rompe el chequeo (body truncado)', async () => {
  // cap chico: el JSON se corta, pero el status sigue siendo 200; con spec sin
  // expected_json (solo status) debe seguir sano.
  const r = await followRedirects('http://local.test:' + port + '/ok-web', 'GET', 2000, 5, { validar: validarLocal, captureBody: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.bodyTruncated, true);
  assert.equal(r.body.length, 5);
});

test('e2e SSRF sigue bloqueado: una URL a loopback no se conecta ni con captura', async () => {
  await assert.rejects(
    followRedirects('http://127.0.0.1:' + port + '/ok-web', 'GET', 1500, 5, { captureBody: 65536 }),
    DestinoNoPermitido
  );
});

test('e2e health_mode no sigue la redireccion (maxRedirects=0): redirectBlocked', async () => {
  const r = await followRedirects('http://local.test:' + port + '/tologin', 'GET', 2000, 0, { validar: validarLocal, captureBody: 65536 });
  assert.equal(r.redirectBlocked, true);
  assert.equal(r.redirects, 0);
  assert.match(String(r.location), /login/);
  const v = evaluarSalud({ status: r.status, redirects: r.redirects, redirectBlocked: r.redirectBlocked, location: r.location }, specWeb);
  assert.equal(v.ok, false); assert.equal(v.kind, 'redireccion');
});
