const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { esIpPublica, validarDestino, followRedirects, DestinoNoPermitido } = require('../lib/url-guard');

test('IPv4: rangos no publicos', () => {
  for (const ip of ['127.0.0.1', '127.255.255.255', '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1']) {
    assert.equal(esIpPublica(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '100.128.0.1', '11.0.0.1', '93.184.216.34']) {
    assert.equal(esIpPublica(ip), true, ip);
  }
});

test('IPv6: loopback, ULA, link-local, mapeadas y embebidas', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456::1', 'fec0::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '64:ff9b::a00:1',
    '2002:7f00:1::1', '2002:c0a8:101::1', '2001:db8::1', '2001::1', '100::1']) {
    assert.equal(esIpPublica(ip), false, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001:80e::200e', '::ffff:8.8.8.8', '2002:0808:0808::1']) {
    assert.equal(esIpPublica(ip), true, ip);
  }
});

test('validarDestino: solo http/https, sin credenciales, sin localhost', async () => {
  for (const u of ['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)',
    'http://user:pass@example.com/', 'http://localhost/', 'http://foo.localhost/', 'no es url', '']) {
    await assert.rejects(validarDestino(u), DestinoNoPermitido, u);
  }
});

test('validarDestino: IPs literales privadas se rechazan; publicas pasan sin resolver', async () => {
  for (const u of ['http://127.0.0.1:3000/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/',
    'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://10.0.0.1/', 'http://0.0.0.0/']) {
    await assert.rejects(validarDestino(u), DestinoNoPermitido, u);
  }
  const r = await validarDestino('https://93.184.216.34/', { resolver: async () => { throw new Error('no debe resolver'); } });
  assert.equal(r.address, '93.184.216.34');
});

const resolverFalso = async (h) => ({
  'ok.test': [{ address: '93.184.216.34', family: 4 }],
  'mixto.test': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
  'interno.test': [{ address: '192.168.0.10', family: 4 }],
  'v6.test': [{ address: 'fd00::10', family: 6 }]
})[h] || [];

test('validarDestino: devuelve todas las direcciones validadas, IPv4 primero', async () => {
  const resolver = async () => [{ address: '2606:4700:4700::1111', family: 6 }, { address: '1.1.1.1', family: 4 }];
  const r = await validarDestino('https://dual.test/', { resolver });
  assert.equal(r.address, '1.1.1.1');
  assert.deepEqual(r.addresses.map(a => a.address), ['1.1.1.1', '2606:4700:4700::1111']);
});

test('validarDestino: nombre que resuelve (aunque sea parcialmente) a privada se rechaza', async () => {
  const ok = await validarDestino('http://ok.test/x', { resolver: resolverFalso });
  assert.equal(ok.address, '93.184.216.34');
  await assert.rejects(validarDestino('http://mixto.test/', { resolver: resolverFalso }), /no publica/);
  await assert.rejects(validarDestino('http://interno.test/', { resolver: resolverFalso }), /no publica/);
  await assert.rejects(validarDestino('http://v6.test/', { resolver: resolverFalso }), /no publica/);
  await assert.rejects(validarDestino('http://noexiste.test/', { resolver: resolverFalso }), /No se pudo resolver/);
});

// ---------- followRedirects contra un servidor local ----------
//
// 127.0.0.1 nunca pasa el validador real, asi que para que el PRIMER salto
// llegue al servidor de prueba se inyecta un validador que permite solamente
// el host "local.test" y delega todo lo demas (las redirecciones) al real.
// Eso ejercita la cadena de verdad: cada Location pasa por validarDestino.
let srv, port;
const hits = [];
test('setup servidor local', async () => {
  srv = http.createServer((req, res) => {
    hits.push(req.url);
    const redir = (to) => { res.writeHead(302, { Location: to }); res.end(); };
    if (req.url === '/a-loopback') return redir('http://127.0.0.1:' + port + '/secreto');
    if (req.url === '/a-metadata') return redir('http://169.254.169.254/latest/meta-data/');
    if (req.url === '/a-nombre-interno') return redir('http://interno.test/');
    if (req.url === '/a-v6') return redir('http://[::1]:' + port + '/secreto');
    if (req.url === '/a-ftp') return redir('ftp://example.com/');
    if (req.url === '/a-relativo') return redir('/secreto'); // mismo host: vuelve a pasar por el validador
    if (req.url === '/a-ok') return redir('/fin');
    if (req.url === '/secreto') { res.writeHead(200); return res.end('NO DEBERIA LLEGAR'); }
    res.writeHead(200); res.end('ok');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
});
after(() => srv && srv.close());

// Solo "local.test" (el primer salto) se resuelve al servidor de prueba. Lo
// demas va al validador real con un resolvedor falso para no tocar DNS.
const validarDePrueba = async (url) => {
  const u = new URL(url);
  if (u.hostname === 'local.test') return { url, hostname: 'local.test', address: '127.0.0.1', family: 4 };
  return validarDestino(url, { resolver: resolverFalso });
};

test('la URL inicial que apunta a loopback nunca se conecta', async () => {
  hits.length = 0;
  await assert.rejects(followRedirects('http://127.0.0.1:' + port + '/secreto', 'GET', 2000, 5), DestinoNoPermitido);
  await assert.rejects(followRedirects('http://[::1]:' + port + '/secreto', 'GET', 2000, 5), DestinoNoPermitido);
  assert.deepEqual(hits, []);
});

test('DNS rebinding: la conexion usa la direccion validada, no el DNS del sistema', async () => {
  // "local.test" no existe en DNS: si la conexion llega, fue por el lookup fijo.
  hits.length = 0;
  const r = await followRedirects('http://local.test:' + port + '/fin', 'GET', 2000, 5, { validar: validarDePrueba });
  assert.equal(r.status, 200);
  assert.deepEqual(hits, ['/fin']);
});

test('redirecciones a loopback, metadata, nombre interno, IPv6 local o esquema no http se cortan sin conectar', async () => {
  for (const ruta of ['/a-loopback', '/a-metadata', '/a-nombre-interno', '/a-v6', '/a-ftp']) {
    hits.length = 0;
    await assert.rejects(
      followRedirects('http://local.test:' + port + ruta, 'GET', 2000, 5, { validar: validarDePrueba }),
      DestinoNoPermitido, ruta
    );
    assert.deepEqual(hits, [ruta], 'solo el primer salto debe haberse conectado');
  }
});

test('redireccion relativa al mismo host vuelve a validarse y sigue', async () => {
  hits.length = 0;
  const r = await followRedirects('http://local.test:' + port + '/a-ok', 'GET', 2000, 5, { validar: validarDePrueba });
  assert.equal(r.status, 200);
  assert.equal(r.redirects, 1);
  assert.deepEqual(hits, ['/a-ok', '/fin']);
});

test('sin ruta a la primera direccion validada, se prueba la siguiente; con ECONNREFUSED, no', async () => {
  // Primera candidata: una IPv6 que en esta maquina no tiene ruta (documentacion,
  // pero el validador de prueba la da por validada). Segunda: el servidor local.
  const validarDual = async (url) => ({ url, hostname: 'dual.test', address: '2001:db8::1', family: 6,
    addresses: [{ address: '2001:db8::1', family: 6 }, { address: '127.0.0.1', family: 4 }] });
  hits.length = 0;
  let r;
  try { r = await followRedirects('http://dual.test:' + port + '/fin', 'GET', 4000, 5, { validar: validarDual }); }
  catch (e) {
    // Si la maquina SI tiene ruta IPv6, el intento a 2001:db8::1 termina en timeout
    // y no en ENETUNREACH: en ese caso el fallback no aplica y la prueba no decide.
    if (e.message === 'Timeout') return;
    throw e;
  }
  assert.equal(r.status, 200);
  assert.deepEqual(hits, ['/fin']);
  // Un puerto cerrado (ECONNREFUSED) es respuesta del destino: no se salta a la siguiente
  const srv2 = http.createServer(); await new Promise(res => srv2.listen(0, '127.0.0.1', res));
  const puertoCerrado = srv2.address().port; await new Promise(res => srv2.close(res));
  const validarCerrado = async (url) => ({ url, hostname: 'x.test', address: '127.0.0.1', family: 4,
    addresses: [{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  hits.length = 0;
  await assert.rejects(followRedirects('http://x.test:' + puertoCerrado + '/fin', 'GET', 2000, 5, { validar: validarCerrado }), /ECONNREFUSED/);
});

test('sin validador inyectado, ni siquiera local.test se conecta (no hay bypass por defecto)', async () => {
  hits.length = 0;
  await assert.rejects(followRedirects('http://local.test:' + port + '/fin', 'GET', 1500, 5), DestinoNoPermitido);
  assert.deepEqual(hits, []);
});
