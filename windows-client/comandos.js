// Registro persistente de comandos remotos.
//
// Cada comando que llega del servidor pasa por aca antes de ejecutarse. El
// registro vive en un archivo JSON al lado del ejecutable, por dos motivos:
//
//   1. Si el resultado no se pudo mandar (se corto la red justo despues de
//      ejecutar), hay que reenviarlo en el proximo latido SIN volver a
//      ejecutar el comando. Un "reinicia el servicio" ejecutado dos veces no es
//      lo mismo que uno.
//   2. Si el agente se reinicia mientras un comando corre, al arrancar no se
//      sabe si llego a terminar. Se informa como "indeterminate" y no se repite:
//      repetir por las nuestras un comando potencialmente destructivo es peor
//      que dejar que el usuario mire y decida.
//
// Estados de una entrada:
//   ejecutando  se anoto antes de lanzar el proceso
//   listo       termino (o se dio por indeterminado) y falta mandar el resultado
//   enviado     el servidor acepto el resultado; se conserva unos dias por si
//               el mismo id volviera a aparecer
//
// Esto NO garantiza "exactamente una vez": si el proceso muere entre ejecutar
// y anotar "listo", la entrada queda en "ejecutando" y se informa como
// indeterminada aunque haya corrido bien. Es la unica opcion honesta.
const fs = require('fs');

const DIAS_RETENCION = 7;
const MAX_INTENTOS_ENVIO = 50; // ~25 min a un latido cada 30s; despues se deja de insistir

class RegistroComandos {
  // opts: { archivo, log, enviar(id, {status, output}) -> {ok, status}, ejecutar(command) -> output }
  constructor(opts) {
    this.archivo = opts.archivo;
    this.log = opts.log || (() => {});
    this.enviar = opts.enviar;
    this.ejecutar = opts.ejecutar;
    this.ahora = opts.ahora || (() => Date.now());
    this.enProceso = new Set(); // ids que este proceso esta ejecutando o enviando ahora mismo
    this.entradas = this._cargar();
  }

  _cargar() {
    try {
      if (fs.existsSync(this.archivo)) {
        const j = JSON.parse(fs.readFileSync(this.archivo, 'utf8'));
        if (j && typeof j === 'object') return j;
      }
    } catch (e) { this.log(`Registro de comandos ilegible, se empieza de cero: ${e.message}`); }
    return {};
  }

  _guardar() {
    // Escritura atomica: primero a un temporal, despues rename. Si se corta la
    // luz a mitad de la escritura no queda un JSON a medias.
    const tmp = this.archivo + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.entradas, null, 2));
    fs.renameSync(tmp, this.archivo);
  }

  // Al arrancar: lo que quedo "ejecutando" no se sabe como termino.
  marcarReinicio() {
    let n = 0;
    for (const [id, e] of Object.entries(this.entradas)) {
      if (e.estado === 'ejecutando') {
        e.estado = 'listo';
        e.status = 'indeterminate';
        e.output = '[INDETERMINADO] El agente se reinicio mientras este comando se ejecutaba. ' +
          'No se sabe si termino; no se volvio a ejecutar. Revisar a mano antes de repetirlo.';
        e.terminado = this.ahora();
        n++;
        this.log(`Comando #${id} quedo a medias por un reinicio: se informa como indeterminado, no se repite`);
      }
    }
    this._podar();
    if (n > 0) this._guardar();
    return n;
  }

  _podar() {
    const limite = this.ahora() - DIAS_RETENCION * 24 * 60 * 60 * 1000;
    for (const [id, e] of Object.entries(this.entradas)) {
      if (e.estado === 'enviado' && (e.enviado || 0) < limite) delete this.entradas[id];
    }
  }

  // Manda al servidor todo lo que este "listo". Devuelve cuantos quedaron enviados.
  async reenviarPendientes() {
    let enviados = 0;
    for (const [id, e] of Object.entries(this.entradas)) {
      if (e.estado !== 'listo' || this.enProceso.has(id)) continue;
      if ((e.intentosEnvio || 0) >= MAX_INTENTOS_ENVIO) continue;
      this.enProceso.add(id);
      try {
        if (await this._enviarResultado(id, e)) enviados++;
      } finally {
        this.enProceso.delete(id);
      }
    }
    return enviados;
  }

  async _enviarResultado(id, e) {
    e.intentosEnvio = (e.intentosEnvio || 0) + 1;
    try {
      const r = await this.enviar(id, { status: e.status, output: e.output });
      // 2xx: aceptado. 404: el comando ya no existe en el servidor (borraron
      // la maquina, o el id es de otra epoca): no tiene sentido seguir mandando.
      if (r && (r.ok || r.status === 404)) {
        e.estado = 'enviado';
        e.enviado = this.ahora();
        this._guardar();
        return true;
      }
      this.log(`Comando #${id}: el servidor no acepto el resultado (HTTP ${r && r.status}); se reintenta en el proximo latido`);
    } catch (err) {
      this.log(`Comando #${id}: no se pudo enviar el resultado (${err.message}); se reintenta en el proximo latido`);
    }
    this._guardar();
    return false;
  }

  // Procesa la tanda que vino en un latido. `cmds` ya viene con la firma
  // verificada por quien llama.
  async procesar(cmds) {
    for (const cmd of cmds) {
      const id = String(cmd.id);
      const previa = this.entradas[id];
      if (this.enProceso.has(id)) {
        this.log(`Comando #${id} ya esta en curso en este proceso, se ignora la repeticion`);
        continue;
      }
      if (previa) {
        // Ya lo conocemos: nunca se vuelve a ejecutar. Como mucho se reenvia.
        if (previa.estado === 'listo') {
          this.log(`Comando #${id} ya se ejecuto, se reenvia el resultado`);
          this.enProceso.add(id);
          try { await this._enviarResultado(id, previa); } finally { this.enProceso.delete(id); }
        } else {
          this.log(`Comando #${id} ya fue ${previa.estado === 'enviado' ? 'informado' : 'procesado'}, no se repite`);
        }
        continue;
      }

      this.enProceso.add(id);
      try {
        this.entradas[id] = { estado: 'ejecutando', comando: cmd.command, iniciado: this.ahora() };
        this._guardar(); // antes de ejecutar: si morimos en el medio, queda rastro
        let status = 'completed';
        let output;
        try {
          output = await this.ejecutar(cmd.command);
        } catch (err) {
          status = 'failed';
          output = `[ERROR] No se pudo ejecutar: ${err.message}`;
        }
        const e = this.entradas[id];
        e.estado = 'listo'; e.status = status; e.output = output; e.terminado = this.ahora();
        this._guardar();
        await this._enviarResultado(id, e);
      } finally {
        this.enProceso.delete(id);
      }
    }
  }
}

module.exports = { RegistroComandos, DIAS_RETENCION, MAX_INTENTOS_ENVIO };
