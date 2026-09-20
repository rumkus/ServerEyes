// inspeccionarCertificado contra un servidor TLS local con certificado
// autofirmado y VENCIDO generado al vuelo con openssl (si no esta, se salta).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { inspeccionarCertificado, validarDestino, DestinoNoPermitido } = require('../lib/url-guard');

let openssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch (e) { openssl = false; }
const skip = openssl ? false : 'openssl no disponible';

let dir, srv, port, sniVisto = null, handshakes = 0;
before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-ssl-'));
  // Certificado vencido: valido entre 2020 y 2021. Es material de prueba
  // descartable, se genera en cada corrida y se borra al final.
  // Config minima propia: la maquina puede tener OPENSSL_CONF apuntando a
  // cualquier lado (aca apuntaba a un archivo inexistente de psqlODBC).
  fs.writeFileSync(path.join(dir, 'openssl.cnf'), ['[req]', 'distinguished_name = dn', '[dn]', ''].join('\n'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=vencido.test',
    '-not_before', '20200101000000Z', '-not_after', '20210101000000Z',
    '-config', path.join(dir, 'openssl.cnf'),
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')],
    { stdio: 'ignore', env: { ...process.env, OPENSSL_CONF: path.join(dir, 'openssl.cnf') } });
  srv = tls.createServer({
    key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')),
    SNICallback: (name, cb) => { sniVisto = name; cb(null, tls.createSecureContext({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) })); }
  }, (sock) => { handshakes++; sock.on('error', () => {}); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
});
after(() => { if (srv) srv.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

// Validador de prueba: solo "local.test" va al servidor local; el resto, real.
const validarDePrueba = async (url) => {
  const u = new URL(url);
  if (u.hostname === 'local.test') return { url, hostname: 'local.test', address: '127.0.0.1', family: 4 };
  return validarDestino(url, { resolver: async (h) => h === 'interno.test' ? [{ address: '10.0.0.9', family: 4 }] : [] });
};

test('lee un certificado VENCIDO y autofirmado sin rechazarlo, con el hostname original como SNI', { skip }, async () => {
  sniVisto = null;
  const r = await inspeccionarCertificado('local.test', { port, validar: validarDePrueba });
  assert.equal(r.cert.subject.CN, 'vencido.test');
  assert.ok(new Date(r.cert.valid_to) < new Date(), 'esta vencido');
  assert.equal(r.authorized, false);
  assert.equal(sniVisto, 'local.test', 'el SNI conserva el nombre pedido, no la IP');
});

test('un host que resuelve a red interna no dispara ningun handshake', { skip }, async () => {
  const antes = handshakes;
  await assert.rejects(inspeccionarCertificado('interno.test', { port, validar: validarDePrueba }), DestinoNoPermitido);
  await assert.rejects(inspeccionarCertificado('127.0.0.1', { port, validar: validarDePrueba }), DestinoNoPermitido);
  await assert.rejects(inspeccionarCertificado('[::1]', { port, validar: validarDePrueba }), DestinoNoPermitido);
  await assert.rejects(inspeccionarCertificado('localhost', { port, validar: validarDePrueba }), DestinoNoPermitido);
  assert.equal(handshakes, antes);
});

test('sin validador inyectado no hay forma de llegar al servidor local', { skip }, async () => {
  const antes = handshakes;
  await assert.rejects(inspeccionarCertificado('local.test', { port }), DestinoNoPermitido);
  await assert.rejects(inspeccionarCertificado('127.0.0.1', { port }), DestinoNoPermitido);
  assert.equal(handshakes, antes);
});
