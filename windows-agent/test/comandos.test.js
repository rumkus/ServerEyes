const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RegistroComandos } = require('../comandos');

let dir, archivo;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-cmd-')); archivo = path.join(dir, 'comandos.json'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// Servidor falso: se le puede decir que rechace, y cuenta lo que recibio
function servidorFalso() {
  const recibidos = [];
  let modo = 'ok';
  return {
    recibidos,
    setModo: (m) => { modo = m; },
    enviar: async (id, r) => {
      if (modo === 'caido') throw new Error('ECONNREFUSED');
      if (modo === '500') return { ok: false, status: 500 };
      recibidos.push({ id, ...r });
      return { ok: true, status: 200 };
    }
  };
}

function registro(srv, ejecutar, extra = {}) {
  return new RegistroComandos({ archivo, log: () => {}, enviar: srv.enviar, ejecutar, ...extra });
}

test('flujo normal: ejecuta, manda, y el mismo id no se vuelve a ejecutar', async () => {
  const srv = servidorFalso();
  const ejecutados = [];
  const reg = registro(srv, async (c) => { ejecutados.push(c); return 'salida de ' + c; });
  await reg.procesar([{ id: 1, command: 'echo a' }]);
  assert.deepEqual(ejecutados, ['echo a']);
  assert.deepEqual(srv.recibidos, [{ id: '1', status: 'completed', output: 'salida de echo a' }]);
  // El servidor no lo reentrega, pero si lo hiciera:
  await reg.procesar([{ id: 1, command: 'echo a' }]);
  assert.equal(ejecutados.length, 1, 'no se repite');
  assert.equal(srv.recibidos.length, 1, 'ni se reenvia lo ya aceptado');
});

test('si falla el envio, el resultado se reenvia en el proximo latido SIN volver a ejecutar', async () => {
  const srv = servidorFalso();
  let ejecuciones = 0;
  const reg = registro(srv, async () => { ejecuciones++; return 'ok'; });
  srv.setModo('caido');
  await reg.procesar([{ id: 7, command: 'shutdown /r' }]);
  assert.equal(ejecuciones, 1);
  assert.equal(srv.recibidos.length, 0);
  const guardado = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  assert.equal(guardado['7'].estado, 'listo', 'quedo persistido como listo para reenviar');

  srv.setModo('500');
  assert.equal(await reg.reenviarPendientes(), 0);
  assert.equal(ejecuciones, 1);

  srv.setModo('ok');
  assert.equal(await reg.reenviarPendientes(), 1);
  assert.equal(ejecuciones, 1, 'nunca se volvio a ejecutar');
  assert.deepEqual(srv.recibidos, [{ id: '7', status: 'completed', output: 'ok' }]);
  assert.equal(JSON.parse(fs.readFileSync(archivo, 'utf8'))['7'].estado, 'enviado');
});

test('el registro sobrevive a un reinicio del proceso: otra instancia reenvia sin ejecutar', async () => {
  const srv = servidorFalso();
  srv.setModo('caido');
  const reg1 = registro(srv, async () => 'resultado');
  await reg1.procesar([{ id: 3, command: 'x' }]);

  let ejecutoOtraVez = false;
  const reg2 = registro(srv, async () => { ejecutoOtraVez = true; return 'otra'; });
  reg2.marcarReinicio();
  srv.setModo('ok');
  await reg2.procesar([{ id: 3, command: 'x' }]); // el server (viejo) lo reentrega
  assert.equal(ejecutoOtraVez, false);
  assert.deepEqual(srv.recibidos, [{ id: '3', status: 'completed', output: 'resultado' }]);
});

test('reinicio durante la ejecucion: se informa indeterminado y NO se repite', async () => {
  const srv = servidorFalso();
  // Simulamos un proceso que muere en medio de ejecutar(): la entrada queda "ejecutando"
  const reg1 = registro(srv, () => new Promise(() => {})); // nunca termina
  reg1.procesar([{ id: 9, command: 'format c:' }]);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(JSON.parse(fs.readFileSync(archivo, 'utf8'))['9'].estado, 'ejecutando');

  let ejecuciones = 0;
  const reg2 = registro(srv, async () => { ejecuciones++; return 'no'; });
  assert.equal(reg2.marcarReinicio(), 1);
  await reg2.procesar([{ id: 9, command: 'format c:' }]);
  assert.equal(ejecuciones, 0, 'un comando potencialmente destructivo no se repite solo');
  assert.equal(srv.recibidos.length, 1);
  assert.equal(srv.recibidos[0].status, 'indeterminate');
  assert.match(srv.recibidos[0].output, /INDETERMINADO/);
});

test('latidos solapados: el mismo id no se ejecuta dos veces en paralelo', async () => {
  const srv = servidorFalso();
  let enCurso = 0, maxEnCurso = 0, ejecuciones = 0;
  const reg = registro(srv, async () => {
    ejecuciones++; enCurso++; maxEnCurso = Math.max(maxEnCurso, enCurso);
    await new Promise(r => setTimeout(r, 30));
    enCurso--; return 'ok';
  });
  await Promise.all([
    reg.procesar([{ id: 5, command: 'a' }]),
    reg.procesar([{ id: 5, command: 'a' }]),
    reg.procesar([{ id: 5, command: 'a' }])
  ]);
  assert.equal(ejecuciones, 1);
  assert.equal(maxEnCurso, 1);
  assert.equal(srv.recibidos.length, 1);
});

test('si ejecutar() lanza, se informa failed (no se pierde el id)', async () => {
  const srv = servidorFalso();
  const reg = registro(srv, async () => { throw new Error('spawn ENOENT'); });
  await reg.procesar([{ id: 11, command: 'noexiste' }]);
  assert.equal(srv.recibidos[0].status, 'failed');
  assert.match(srv.recibidos[0].output, /ENOENT/);
});

test('404 del servidor (comando ya no existe) deja de reintentar; los enviados viejos se podan', async () => {
  const srv = servidorFalso();
  srv.enviar = async () => ({ ok: false, status: 404 });
  let t = Date.now();
  const reg = registro(srv, async () => 'x', { ahora: () => t });
  await reg.procesar([{ id: 20, command: 'x' }]);
  assert.equal(JSON.parse(fs.readFileSync(archivo, 'utf8'))['20'].estado, 'enviado');
  t += 8 * 24 * 60 * 60 * 1000;
  const reg2 = registro(srv, async () => 'x', { ahora: () => t });
  reg2.marcarReinicio();
  assert.equal(reg2.entradas['20'], undefined);
});

test('archivo corrupto no tira el agente: se empieza de cero', () => {
  fs.writeFileSync(archivo, '{ esto no es json');
  const reg = registro(servidorFalso(), async () => 'x');
  assert.deepEqual(reg.entradas, {});
});
