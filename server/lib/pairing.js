// Vinculacion de agentes.
//
// El agente pide un codigo de 6 digitos que el usuario tipea en la app. Ese
// codigo es publico por naturaleza (se muestra en pantalla, se dicta por
// telefono), asi que no puede ser lo unico que haga falta para retirar la
// machine_key: cualquiera que lo adivinara antes que el agente se quedaba con
// la clave y con el control de la maquina.
//
// Por eso el pedido devuelve ademas un pairing_token secreto, largo y
// aleatorio, que solo conoce el proceso que inicio la vinculacion. Consultar
// el estado y retirar la clave exige ese token. El codigo solo sirve para que
// el usuario lo confirme desde la app.
//
// Todo vive en memoria: una vinculacion dura 5 minutos y si el servidor se
// reinicia en el medio se vuelve a pedir el codigo. No hay nada que guardar.
const crypto = require('crypto');

const DEFAULTS = {
  ttlMs: 5 * 60 * 1000,        // vida de un codigo
  // Consultas con token equivocado por codigo y por minuto antes de responder
  // 429 a ESAS consultas. Nunca anulan el codigo: el token correcto son 32
  // bytes aleatorios, adivinarlo no es viable, y anular la vinculacion por
  // intentos ajenos permitiria que cualquiera que vea el codigo en pantalla
  // le tire abajo la sesion al agente legitimo.
  maxTokenFailsPorMinuto: 30,
  maxConfirmFails: 8,          // codigos equivocados por usuario antes de frenarlo
  confirmWindowMs: 10 * 60 * 1000,
  maxRequestsPerIp: 20,        // pedidos de codigo por IP en la ventana
  requestWindowMs: 10 * 60 * 1000,
  maxPending: 5000,            // techo global de codigos vivos
  // Tras confirmar, el agente puede retirar la clave todas las veces que haga
  // falta con el MISMO token mientras el codigo siga vigente: que el servidor
  // haya enviado la respuesta no prueba que el agente la recibio. Lo que se
  // acota es la frecuencia de consultas por codigo (el agente pregunta cada
  // 2 s; 120 por minuto es holgado) y el tiempo: TTL mas una gracia corta
  // despues de confirmar.
  maxStatusPorMinuto: 120,
  graciaPostConfirmMs: 2 * 60 * 1000
};

function igualesEnTiempoConstante(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

class PairingStore {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.now = opts.now || (() => Date.now());
    this.pendientes = new Map();      // code -> entrada
    this.fallosConfirm = new Map();   // userId -> { n, desde }
    this.pedidosPorIp = new Map();    // ip -> { n, desde }
    this.statusPorCodigo = new Map(); // code -> { n, desde } (consultas con token correcto)
    this.fallosToken = new Map();     // code -> { n, desde } (consultas con token equivocado)
  }

  _barrer() {
    const t = this.now();
    for (const [code, e] of this.pendientes) {
      if (e.expira <= t) this.pendientes.delete(code);
    }
    for (const [k, v] of this.fallosConfirm) if (t - v.desde > this.opts.confirmWindowMs) this.fallosConfirm.delete(k);
    for (const [k, v] of this.pedidosPorIp) if (t - v.desde > this.opts.requestWindowMs) this.pedidosPorIp.delete(k);
    for (const [k, v] of this.statusPorCodigo) if (t - v.desde > 60000 && !this.pendientes.has(k)) this.statusPorCodigo.delete(k);
    for (const [k, v] of this.fallosToken) if (t - v.desde > 60000 && !this.pendientes.has(k)) this.fallosToken.delete(k);
  }

  _contar(mapa, clave, ventanaMs) {
    const t = this.now();
    let v = mapa.get(clave);
    if (!v || t - v.desde > ventanaMs) { v = { n: 0, desde: t }; mapa.set(clave, v); }
    v.n++;
    return v.n;
  }

  // El agente pide un codigo. Devuelve el codigo visible y el token secreto.
  request({ machine_name, os_info, ip }) {
    this._barrer();
    if (ip && this._contar(this.pedidosPorIp, ip, this.opts.requestWindowMs) > this.opts.maxRequestsPerIp) {
      return { error: 'Demasiados pedidos de vinculacion, espera unos minutos', status: 429 };
    }
    if (this.pendientes.size >= this.opts.maxPending) {
      return { error: 'Servidor ocupado, intenta en unos minutos', status: 503 };
    }
    let code;
    do { code = String(crypto.randomInt(100000, 1000000)); } while (this.pendientes.has(code));
    const pairing_token = crypto.randomBytes(32).toString('hex');
    const t = this.now();
    this.pendientes.set(code, {
      machine_name, os_info: os_info || '',
      token: pairing_token,
      creado: t, expira: t + this.opts.ttlMs,
      estado: 'pendiente',   // pendiente -> confirmando -> confirmado
      machine_key: null
    });
    return { code, pairing_token, expires_in: Math.floor(this.opts.ttlMs / 1000) };
  }

  // El usuario confirma el codigo desde la app. crearMaquina(entrada) hace el
  // INSERT y devuelve la fila; se llama una sola vez por codigo aunque lleguen
  // dos confirmaciones a la vez: la entrada pasa a "confirmando" antes del
  // primer await, y la segunda ya la encuentra tomada.
  async confirm({ code, userId, crearMaquina }) {
    this._barrer();
    const e = this.pendientes.get(String(code || ''));
    if (!e || e.estado !== 'pendiente') {
      const n = this._contar(this.fallosConfirm, userId, this.opts.confirmWindowMs);
      if (n > this.opts.maxConfirmFails) return { error: 'Demasiados intentos, espera unos minutos', status: 429 };
      if (e && e.estado !== 'pendiente') return { error: 'Codigo ya fue usado', status: 409 };
      return { error: 'Codigo invalido o expirado', status: 404 };
    }
    e.estado = 'confirmando';
    try {
      const machine = await crearMaquina(e);
      e.machine_key = machine.machine_key;
      e.estado = 'confirmado';
      // Que la confirmacion a ultimo momento no deje al agente sin tiempo de retirar la clave
      e.expira = Math.max(e.expira, this.now() + this.opts.graciaPostConfirmMs);
      this.fallosConfirm.delete(userId);
      return { machine };
    } catch (err) {
      // Si el INSERT fallo, el codigo vuelve a estar disponible para reintentar.
      e.estado = 'pendiente';
      throw err;
    }
  }

  // El agente consulta con su token. Solo el que tiene el token retira la
  // clave, y puede retirarla las veces que necesite (respuestas perdidas,
  // reintentos) hasta que el codigo venza. El codigo visible solo nunca
  // alcanza.
  //
  // Los contadores de tokens equivocados y de consultas legitimas son
  // independientes: primero se compara el token, y segun el resultado se
  // cuenta en uno u otro. Asi, alguien que conozca el codigo y bombardee con
  // tokens falsos recibe 429 sobre SUS consultas, pero ni anula el codigo ni
  // consume el cupo del agente legitimo, que sigue pudiendo retirar la clave
  // hasta el vencimiento.
  status({ code, token }) {
    this._barrer();
    const e = this.pendientes.get(String(code || ''));
    if (!e) return { error: 'Codigo invalido o expirado', status: 404 };
    if (!igualesEnTiempoConstante(token || '', e.token)) {
      if (this._contar(this.fallosToken, String(code), 60000) > this.opts.maxTokenFailsPorMinuto) {
        return { error: 'Demasiados intentos invalidos para este codigo', status: 429 };
      }
      return { error: 'Token de vinculacion invalido', status: 401 };
    }
    if (this._contar(this.statusPorCodigo, String(code), 60000) > this.opts.maxStatusPorMinuto) {
      return { error: 'Demasiadas consultas para este codigo, espera un momento', status: 429 };
    }
    if (e.estado !== 'confirmado') return { confirmed: false };
    return { confirmed: true, machine_key: e.machine_key };
  }

  // Para los tests y el log
  size() { this._barrer(); return this.pendientes.size; }
}

module.exports = { PairingStore, DEFAULTS };
