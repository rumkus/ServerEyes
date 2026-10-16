const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluarSalud, clasificarError, esHealthCheck } = require('../lib/health-check');

// Spec tipica de un control de salud (web/admin/api de staging).
const specWeb = { expected_status: 200, expected_json: { status: 'ok', service: 'web' }, health_mode: true, enforce_tls: true };

test('sano: 200 + JSON esperado + sin redireccion', () => {
  const v = evaluarSalud({ status: 200, body: '{"status":"ok","service":"web"}', redirects: 0, tls: { authorized: true } }, specWeb);
  assert.deepEqual(v, { ok: true, kind: null, detail: null });
});

test('caida: 503', () => {
  const v = evaluarSalud({ status: 503, body: 'Service Unavailable', redirects: 0, tls: { authorized: true } }, specWeb);
  assert.equal(v.ok, false); assert.equal(v.kind, 'http'); assert.match(v.detail, /503/);
});

test('caida: JSON invalido (no parsea)', () => {
  const v = evaluarSalud({ status: 200, body: '<html>maintenance</html>', redirects: 0, tls: { authorized: true } }, specWeb);
  assert.equal(v.ok, false); assert.equal(v.kind, 'json');
});

test('caida: JSON valido pero valor distinto', () => {
  const v = evaluarSalud({ status: 200, body: '{"status":"degraded","service":"web"}', redirects: 0, tls: { authorized: true } }, specWeb);
  assert.equal(v.ok, false); assert.equal(v.kind, 'json'); assert.match(v.detail, /status/);
});

test('caida: servicio equivocado (web responde con service=api)', () => {
  const v = evaluarSalud({ status: 200, body: '{"status":"ok","service":"api"}', redirects: 0, tls: { authorized: true } }, specWeb);
  assert.equal(v.ok, false); assert.equal(v.kind, 'json'); assert.match(v.detail, /service/);
});

test('caida: redireccion a login no es sana aunque termine en 200', () => {
  const v = evaluarSalud({ status: 200, body: '{"status":"ok","service":"web"}', redirects: 1, finalUrl: 'https://x/login' }, specWeb);
  assert.equal(v.ok, false); assert.equal(v.kind, 'redireccion'); assert.match(v.detail, /login/);
});

test('caida: timeout', () => {
  const v = evaluarSalud({ error: new Error('Timeout') }, specWeb);
  assert.equal(v.ok, false); assert.equal(v.kind, 'timeout');
});

test('caida: DNS', () => {
  const e = new Error('getaddrinfo ENOTFOUND x'); e.code = 'ENOTFOUND';
  const v = evaluarSalud({ error: e }, specWeb);
  assert.equal(v.kind, 'dns');
});

test('caida: TLS exigido y certificado no confiable', () => {
  const v = evaluarSalud({ status: 200, body: '{"status":"ok","service":"web"}', redirects: 0, tls: { authorized: false, authorizationError: 'CERT_HAS_EXPIRED' } }, specWeb);
  assert.equal(v.ok, false); assert.equal(v.kind, 'tls'); assert.match(v.detail, /EXPIRED/);
});

test('caida: conexion rechazada', () => {
  const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED';
  assert.equal(evaluarSalud({ error: e }, specWeb).kind, 'conexion');
});

test('caida: destino SSRF', () => {
  const e = new Error('Destino no permitido'); e.code = 'DESTINO_NO_PERMITIDO';
  assert.equal(evaluarSalud({ error: e }, specWeb).kind, 'ssrf');
});

test('recuperacion: vuelve a 200 + JSON ok', () => {
  assert.equal(evaluarSalud({ status: 200, body: '{"status":"ok","service":"web"}', redirects: 0, tls: { authorized: true } }, specWeb).ok, true);
});

test('clasificarError mapea los codigos de red', () => {
  assert.equal(clasificarError({ code: 'EAI_AGAIN', message: 'x' }).kind, 'dns');
  assert.equal(clasificarError({ code: 'CERT_HAS_EXPIRED', message: 'x' }).kind, 'tls');
  assert.equal(clasificarError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'x' }).kind, 'tls');
  assert.equal(clasificarError({ message: 'socket hang up Timeout' }).kind, 'timeout');
  assert.equal(clasificarError({ code: 'ECONNRESET', message: 'x' }).kind, 'conexion');
});

// --- Monitores clasicos: no cambia el comportamiento historico ---
test('clasico (sin health_mode): 2xx/3xx = sano, >=400 = caida', () => {
  const spec = { expected_status: 200 };
  assert.equal(esHealthCheck(spec), false);
  assert.equal(evaluarSalud({ status: 200, redirects: 0 }, spec).ok, true);
  assert.equal(evaluarSalud({ status: 302, redirects: 1 }, spec).ok, true);   // clasico tolera redireccion
  assert.equal(evaluarSalud({ status: 404, redirects: 0 }, spec).ok, false);
  assert.equal(evaluarSalud({ status: 500, redirects: 0 }, spec).ok, false);
});

test('status esperado configurable (p.ej. 204)', () => {
  const spec = { expected_status: 204, health_mode: true };
  assert.equal(evaluarSalud({ status: 204, redirects: 0 }, spec).ok, true);
  assert.equal(evaluarSalud({ status: 200, redirects: 0 }, spec).ok, false);
});
