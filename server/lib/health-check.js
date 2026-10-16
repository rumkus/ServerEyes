'use strict';
//
// Evaluacion de salud de un endpoint HTTP/HTTPS (monitores "health_mode").
//
// Separado de server.js para poder probarlo en aislamiento (node --test) sin
// base de datos ni red: recibe el resultado de UN intento ya hecho y decide si
// el endpoint esta sano. La politica es intencionalmente estricta para checks
// de salud de apps/APIs:
//   - exige el status exacto esperado (por defecto 200), no "cualquier < 400";
//   - exige que el cuerpo sea JSON y contenga los pares clave/valor indicados;
//   - en health_mode, cualquier redireccion (p.ej. a un login) es CAIDA, no
//     "sano": un /health que redirige a /login no esta sirviendo salud;
//   - si se exige TLS, un certificado no confiable es caida (el handshake se
//     hace con rejectUnauthorized:false para poder observarlo).
//
// Los monitores "clasicos" (sin health_mode ni expected_json) conservan la
// regla historica (sano = 2xx/3xx) para no cambiar el comportamiento de los
// monitores ya existentes en produccion.

// Clasifica el motivo de una caida a partir del error de red/validacion.
// Devuelve { kind, detail }. kind ∈ dns|tls|timeout|conexion|ssrf|desconocido.
function clasificarError(err) {
  if (!err) return { kind: 'desconocido', detail: 'Error desconocido' };
  const code = err.code || '';
  const msg = String(err.message || err || 'Error');

  // SSRF / destino no permitido (lo marca lib/url-guard).
  if (code === 'DESTINO_NO_PERMITIDO') return { kind: 'ssrf', detail: msg };

  // Timeout (timer propio de url-guard o del socket).
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) return { kind: 'timeout', detail: 'Tiempo de espera agotado' };

  // DNS.
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /no se pudo resolver/i.test(msg)) {
    return { kind: 'dns', detail: 'No se pudo resolver el nombre (DNS)' };
  }

  // TLS / certificado.
  const codigosTls = new Set([
    'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_NOT_YET_VALID', 'ERR_SSL_WRONG_VERSION_NUMBER'
  ]);
  if (codigosTls.has(code) || (typeof code === 'string' && (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL'))) ||
      /\bcert(ificad|ificate)?\b|\bSSL\b|\bTLS\b|altname/i.test(msg)) {
    return { kind: 'tls', detail: msg };
  }

  // Conexion (rechazo, reset, sin ruta...).
  if (['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EHOSTDOWN'].includes(code)) {
    return { kind: 'conexion', detail: msg };
  }

  return { kind: 'conexion', detail: msg };
}

// ¿El monitor usa la politica estricta de health-check?
function esHealthCheck(spec) {
  return !!(spec && (spec.health_mode || (spec.expected_json && Object.keys(spec.expected_json).length)));
}

// Evalua un intento. `probe` = resultado de UN request:
//   { status, body, finalUrl, redirects, tls:{authorized,authorizationError}, error }
// `spec` = config del monitor: { expected_status, expected_json, health_mode, enforce_tls }
// Devuelve { ok, kind, detail }. kind=null si ok.
function evaluarSalud(probe, spec) {
  spec = spec || {};
  probe = probe || {};

  // 1) Error de red / validacion / timeout: caida, con motivo clasificado.
  if (probe.error) {
    const c = clasificarError(probe.error);
    return { ok: false, kind: c.kind, detail: c.detail };
  }

  // 2) Monitores clasicos: regla historica (sano = 2xx/3xx). No se toca.
  if (!esHealthCheck(spec)) {
    const up = probe.status >= 200 && probe.status < 400;
    return { ok: up, kind: up ? null : 'http', detail: up ? null : `HTTP ${probe.status}` };
  }

  // --- A partir de aca, politica estricta de health-check ---

  // 3) TLS exigido: un certificado no confiable es caida aunque responda.
  if (spec.enforce_tls && probe.tls && probe.tls.authorized === false) {
    return { ok: false, kind: 'tls', detail: probe.tls.authorizationError || 'Certificado TLS no confiable' };
  }

  // 4) Redireccion: un /health que redirige (a login u otro lado) NO esta sano.
  if (probe.redirects > 0) {
    return { ok: false, kind: 'redireccion', detail: `Redireccion no esperada (${probe.redirects}) -> ${probe.finalUrl || '?'}` };
  }

  // 5) Status exacto.
  const esperado = spec.expected_status || 200;
  if (probe.status !== esperado) {
    return { ok: false, kind: 'http', detail: `HTTP ${probe.status} (esperado ${esperado})` };
  }

  // 6) Cuerpo JSON con los pares esperados.
  if (spec.expected_json && Object.keys(spec.expected_json).length) {
    let parsed;
    try { parsed = JSON.parse(probe.body == null ? '' : probe.body); }
    catch (e) { return { ok: false, kind: 'json', detail: 'La respuesta no es JSON valido' }; }
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, kind: 'json', detail: 'El JSON no es un objeto' };
    }
    for (const [k, v] of Object.entries(spec.expected_json)) {
      if (parsed[k] !== v) {
        return { ok: false, kind: 'json', detail: `JSON: ${k}=${JSON.stringify(parsed[k])} (esperado ${JSON.stringify(v)})` };
      }
    }
  }

  return { ok: true, kind: null, detail: null };
}

module.exports = { evaluarSalud, clasificarError, esHealthCheck };
