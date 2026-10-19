const { test } = require('node:test');
const assert = require('node:assert/strict');
const b = require('../lib/backup-monitor');

const mon = { id: 1, user_id: 1, environment: 'staging', freshness_seconds: 93600 };
const okEvent = () => ({
  event: 'offsite_backup_verified', backupId: 'bk-1', capturedAt: new Date().toISOString(),
  id: 'drivefile123', bytes: 818056, sha256: 'a'.repeat(64), downloadVerified: true, verifiedAt: new Date().toISOString()
});

// ---- token ----
test('token: genera 64 hex y coincide solo el correcto', () => {
  const t = b.generarToken();
  assert.match(t, /^[a-f0-9]{64}$/);
  const h = b.hashTokenHex(t);
  assert.equal(b.tokenCoincide(t, h), true);
  assert.equal(b.tokenCoincide('otro', h), false);
  assert.equal(b.tokenCoincide('', h), false);
  assert.equal(b.tokenCoincide(t, ''), false);
});

// ---- validarVerified ----
test('verified valido', () => {
  const v = b.validarVerified(okEvent(), mon);
  assert.equal(v.ok, true);
  assert.equal(v.datos.fileId, 'drivefile123'); // `id` -> fileId
  assert.equal(v.datos.bytes, 818056);
});
test('verified rechaza downloadVerified!=true', () => {
  const e = okEvent(); e.downloadVerified = false;
  assert.equal(b.validarVerified(e, mon).ok, false);
});
test('verified rechaza bytes<=0, sha invalido, backupId faltante', () => {
  let e = okEvent(); e.bytes = 0; assert.equal(b.validarVerified(e, mon).ok, false);
  e = okEvent(); e.sha256 = 'xyz'; assert.equal(b.validarVerified(e, mon).ok, false);
  e = okEvent(); delete e.backupId; assert.equal(b.validarVerified(e, mon).ok, false);
});
test('verified rechaza capturedAt futuro (>5min) y acepta dentro de tolerancia', () => {
  let e = okEvent(); e.capturedAt = new Date(Date.now() + 10 * 60000).toISOString();
  assert.equal(b.validarVerified(e, mon).ok, false);
  e = okEvent(); e.capturedAt = new Date(Date.now() + 2 * 60000).toISOString();
  assert.equal(b.validarVerified(e, mon).ok, true);
});
test('verified rechaza ambiente distinto y event incorrecto', () => {
  let e = okEvent(); e.environment = 'production';
  assert.equal(b.validarVerified(e, mon).ok, false);
  e = okEvent(); e.event = 'otra_cosa';
  assert.equal(b.validarVerified(e, mon).ok, false);
});

// ---- validarFailed ----
test('failed valido + causa saneada', () => {
  const v = b.validarFailed({ event: 'offsite_backup_failed', runId: 'run-9', reason: 'line1\nline2   x  secret?' }, mon);
  assert.equal(v.ok, true);
  assert.equal(/\n/.test(v.datos.reason), false);
});
test('failed rechaza sin runId ni backupId, event incorrecto, futuro', () => {
  assert.equal(b.validarFailed({ event: 'offsite_backup_failed' }, mon).ok, false);
  assert.equal(b.validarFailed({ event: 'x', runId: 'r' }, mon).ok, false);
  assert.equal(b.validarFailed({ event: 'offsite_backup_failed', runId: 'r', failedAt: new Date(Date.now() + 10 * 60000).toISOString() }, mon).ok, false);
});

// ---- frescura ----
test('estado pendiente sin captura (nunca saludable por defecto)', () => {
  assert.equal(b.estadoFrescura({ last_success_captured_at: null }, new Date()), 'pendiente');
});
test('frontera 26h: exactamente 26h NO vence; mas de 26h si', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const justo = new Date(now.getTime() - 93600 * 1000).toISOString();     // 26h exactas
  const pasado = new Date(now.getTime() - (93600 + 1) * 1000).toISOString(); // 26h+1s
  const reciente = new Date(now.getTime() - 3600 * 1000).toISOString();
  assert.equal(b.estadoFrescura({ last_success_captured_at: justo, freshness_seconds: 93600 }, now), 'saludable');
  assert.equal(b.estadoFrescura({ last_success_captured_at: pasado, freshness_seconds: 93600 }, now), 'vencido');
  assert.equal(b.estadoFrescura({ last_success_captured_at: reciente, freshness_seconds: 93600 }, now), 'saludable');
});
