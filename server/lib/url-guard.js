// Destinos permitidos para los monitores web.
//
// El servidor hace requests a las URLs que cargan los usuarios. Sin control,
// eso permite usarlo para tocar cosas que solo el servidor alcanza: la base de
// datos, la red interna de Railway, el endpoint de metadatos del proveedor,
// localhost. Aca se decide que destinos son legitimos:
//
//   - solo http y https;
//   - solo direcciones publicas, en IPv4 e IPv6;
//   - la conexion va SIEMPRE a una direccion ya validada. Validar el nombre y
//     despues dejar que la libreria resuelva de nuevo abre la puerta al DNS
//     rebinding (el nombre resuelve a algo publico durante la validacion y a
//     127.0.0.1 en la conexion). Por eso se resuelve una vez y se le pasa a
//     http.request un lookup que devuelve esa direccion y ninguna otra;
//   - cada redireccion se valida igual que la URL original.
//
// No hay forma de saltearse esto desde la API ni por configuracion. Los tests
// pueden inyectar un resolvedor para no depender de DNS real.
const net = require('net');
const dns = require('dns');
const https = require('https');
const http = require('http');

// Rangos IPv4 que nunca son un sitio publico. [primer octeto..., bits]
const RANGOS_V4 = [
  ['0.0.0.0', 8],        // "esta red"
  ['10.0.0.0', 8],       // privada
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (y metadatos de nube: 169.254.169.254)
  ['172.16.0.0', 12],    // privada
  ['192.0.0.0', 24],     // IETF
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay (obsoleto)
  ['192.168.0.0', 16],   // privada
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4]       // reservado + broadcast
];

function v4aEntero(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function v4EnRango(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (v4aEntero(ip) & mask) === (v4aEntero(base) & mask);
}

function esIpv4Publica(ip) {
  if (!net.isIPv4(ip)) return false;
  return !RANGOS_V4.some(([base, bits]) => v4EnRango(ip, base, bits));
}

// Expande una IPv6 a 8 grupos de 16 bits.
function v6aGrupos(ip) {
  let s = ip;
  // IPv4 embebida al final (::ffff:1.2.3.4)
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const n = v4aEntero(m[2]);
    s = m[1] + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const partes = s.split('::');
  const izq = partes[0] ? partes[0].split(':') : [];
  const der = partes.length > 1 && partes[1] ? partes[1].split(':') : [];
  const faltan = 8 - izq.length - der.length;
  const grupos = [...izq, ...Array(Math.max(faltan, 0)).fill('0'), ...der].map(g => parseInt(g || '0', 16));
  return grupos;
}

function esIpv6Publica(ip) {
  if (!net.isIPv6(ip)) return false;
  // Quitar zona (fe80::1%eth0)
  const limpia = ip.split('%')[0];
  const g = v6aGrupos(limpia);
  const todosCero = (desde) => g.slice(desde).every(x => x === 0);

  // :: (sin especificar) y ::1 (loopback)
  if (todosCero(0)) return false;
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return false;
  // ::ffff:a.b.c.d  -> IPv4 mapeada: vale lo que valga la IPv4
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return esIpv4Publica(v4Embebida(g[6], g[7]));
  // 64:ff9b::/96 (NAT64) y 64:ff9b:1::/48: la IPv4 va al final
  if (g[0] === 0x64 && g[1] === 0xff9b) return esIpv4Publica(v4Embebida(g[6], g[7]));
  // 2002::/16 (6to4): la IPv4 va en los grupos 1 y 2
  if (g[0] === 0x2002) return esIpv4Publica(v4Embebida(g[1], g[2]));
  // 2001::/32 (Teredo): la IPv4 del servidor va en 2-3; se bloquea entero
  if (g[0] === 0x2001 && g[1] === 0) return false;
  // 2001:db8::/32 documentacion
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
  // 100::/64 descarte
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false;
  // fc00::/7 unique local
  if ((g[0] & 0xfe00) === 0xfc00) return false;
  // fe80::/10 link-local, fec0::/10 site-local (obsoleto)
  if ((g[0] & 0xffc0) === 0xfe80) return false;
  if ((g[0] & 0xffc0) === 0xfec0) return false;
  // ff00::/8 multicast
  if ((g[0] & 0xff00) === 0xff00) return false;
  return true;
}

function v4Embebida(alto, bajo) {
  return [(alto >> 8) & 0xff, alto & 0xff, (bajo >> 8) & 0xff, bajo & 0xff].join('.');
}

function esIpPublica(ip) {
  if (net.isIPv4(ip)) return esIpv4Publica(ip);
  if (net.isIPv6(ip)) return esIpv6Publica(ip);
  return false;
}

class DestinoNoPermitido extends Error {
  constructor(msg) { super(msg); this.name = 'DestinoNoPermitido'; this.code = 'DESTINO_NO_PERMITIDO'; }
}

function resolverPorDefecto(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

// Parsea y valida una URL de monitor. Devuelve { url, hostname, address, family }
// con la direccion concreta a la que hay que conectarse, o lanza
// DestinoNoPermitido. `resolver` es inyectable para los tests.
async function validarDestino(urlStr, { resolver = resolverPorDefecto } = {}) {
  let u;
  try { u = new URL(String(urlStr || '')); } catch (e) { throw new DestinoNoPermitido('URL invalida'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new DestinoNoPermitido('Solo se permiten URLs http y https');
  }
  if (u.username || u.password) throw new DestinoNoPermitido('La URL no puede llevar usuario y contraseña');
  let host = u.hostname;
  if (!host) throw new DestinoNoPermitido('URL sin host');
  // Literal IPv6 viene entre corchetes en u.hostname
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) throw new DestinoNoPermitido('Destino no permitido: localhost');

  let direcciones;
  if (net.isIP(host)) {
    direcciones = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  } else {
    try {
      direcciones = await resolver(host);
    } catch (e) {
      throw new DestinoNoPermitido(`No se pudo resolver ${host}`);
    }
    if (!direcciones || direcciones.length === 0) throw new DestinoNoPermitido(`No se pudo resolver ${host}`);
  }
  // Basta con que UNA de las direcciones sea privada para rechazar el
  // destino: si dejaramos pasar "la publica", el cliente podria elegir la otra.
  for (const d of direcciones) {
    if (!esIpPublica(d.address)) {
      throw new DestinoNoPermitido(`Destino no permitido: ${host} apunta a una direccion no publica (${d.address})`);
    }
  }
  // Todas validadas. Se devuelven todas, IPv4 primero: el servidor puede no
  // tener salida IPv6, y antes de este filtro autoSelectFamily hacia ese
  // fallback solo. Ahora lo hace followRedirects recorriendo esta lista.
  const conFamilia = direcciones.map(d => ({ address: d.address, family: d.family || (net.isIPv6(d.address) ? 6 : 4) }));
  conFamilia.sort((a, b) => a.family - b.family);
  const elegida = conFamilia[0];
  return { url: u.href, hostname: u.hostname, address: elegida.address, family: elegida.family, addresses: conFamilia };
}

// Lookup para http.request que devuelve unicamente la direccion validada.
function lookupFijo(address, family) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (options && options.all) return cb(null, [{ address, family }]);
    cb(null, address, family);
  };
}

// Errores de conexion que justifican probar la siguiente direccion validada
// del mismo host (sin salida IPv6, ruta caida). Un ECONNREFUSED o un timeout
// son respuesta del destino y no se reintentan.
const ERRORES_SIN_RUTA = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT']);

// Sigue redirecciones validando cada destino. Nunca conecta a una direccion
// que no haya pasado por validarDestino.
function followRedirects(urlStr, method, timeoutMs, maxRedirects, opts = {}) {
  const totalTimeout = timeoutMs || 10000;
  const userAgent = opts.userAgent || 'ServerEyes-Monitor/1.0';
  // `validar` es inyectable desde los tests (para apuntar a un servidor local
  // sin abrir un bypass en el validador real); server.js nunca lo pasa.
  const validar = opts.validar || validarDestino;
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let settled = false;
    let current = null;
    // Un unico timer para toda la cadena de redirecciones.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (current) current.destroy();
      reject(new Error('Timeout'));
    }, totalTimeout);
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(val);
    };
    async function doRequest(url) {
      let destino;
      try {
        destino = await validar(url);
      } catch (e) {
        return finish(e);
      }
      if (settled) return;
      const candidatas = (destino.addresses && destino.addresses.length ? destino.addresses : [{ address: destino.address, family: destino.family }]);
      conectar(destino, candidatas, 0);
    }
    function conectar(destino, candidatas, i) {
      const { address, family } = candidatas[i];
      const urlObj = new URL(destino.url);
      const client = urlObj.protocol === 'https:' ? https : http;
      const reqOpts = {
        method: method || 'GET',
        timeout: totalTimeout,
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
          'X-Monitor': 'ServerEyes/1.0'
        },
        // Un certificado vencido no es "sitio caido": eso lo vigila ssl_monitors.
        rejectUnauthorized: false,
        // La conexion va a la direccion validada, no a lo que diga el DNS ahora.
        lookup: lookupFijo(address, family),
        servername: net.isIP(urlObj.hostname) ? undefined : urlObj.hostname
      };
      const r = client.request(urlObj, reqOpts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects >= (maxRedirects || 5)) return finish(new Error('Demasiadas redirecciones (' + redirects + ')'));
          redirects++;
          let next = null;
          try { next = new URL(res.headers.location, urlObj).href; } catch (e) { next = null; }
          if (!next) return finish(new Error('Redirect invalido: ' + res.headers.location));
          doRequest(next);
          return;
        }
        res.resume();
        res.on('end', () => finish(null, { status: res.statusCode, redirects }));
      });
      current = r;
      r.on('error', (e) => {
        // Sin ruta hacia esta direccion: probar la siguiente validada (IPv4
        // despues de una IPv6 sin salida, por ejemplo). Ninguna otra se prueba.
        if (ERRORES_SIN_RUTA.has(e.code) && i + 1 < candidatas.length && !settled) return conectar(destino, candidatas, i + 1);
        finish(e);
      });
      r.on('timeout', () => r.destroy(new Error('Timeout')));
      r.end();
    }
    doRequest(urlStr);
  });
}

// Handshake TLS para leer el certificado de un host (monitores SSL).
//
// Pasa por el mismo validador que los monitores web: el host se resuelve una
// vez, se rechaza si apunta adentro, y la conexion va a ESA direccion
// (`host: address`) conservando el nombre original en `servername` para que
// el SNI sea el correcto. No se envia ningun dato: se lee el certificado y se
// cierra. rejectUnauthorized va en false a proposito: un certificado vencido o
// con cadena rota es justamente lo que un monitor SSL tiene que poder ver.
function inspeccionarCertificado(hostname, opts = {}) {
  const tls = require('tls');
  const port = opts.port || 443;
  const timeoutMs = opts.timeoutMs || 10000;
  const validar = opts.validar || validarDestino;
  return new Promise((resolve, reject) => {
    validar('https://' + String(hostname || '').trim() + ':' + port + '/').then((destino) => {
      let listo = false;
      let socket = null;
      const fin = (err, val) => { if (listo) return; listo = true; try { if (socket) socket.destroy(); } catch (e) {} if (err) reject(err); else resolve(val); };
      socket = tls.connect({
        host: destino.address,          // ya validada: nada de volver a resolver
        port,
        servername: net.isIP(hostname) ? undefined : String(hostname).trim(),
        rejectUnauthorized: false,
        timeout: timeoutMs
      }, () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) return fin(new Error('No se pudo obtener certificado'));
        fin(null, { cert, authorized: socket.authorized, authorizationError: socket.authorizationError });
      });
      socket.on('error', (e) => fin(e));
      socket.on('timeout', () => fin(new Error('Timeout')));
    }, reject);
  });
}

module.exports = { esIpPublica, esIpv4Publica, esIpv6Publica, validarDestino, followRedirects, inspeccionarCertificado, DestinoNoPermitido };
