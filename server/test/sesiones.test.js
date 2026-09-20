const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { firmarToken, verificarToken, revocarSesiones, SesionRevocada } = require('../lib/sesiones');

const SECRET = 'secreto-de-prueba-suficientemente-largo-para-los-tests';

// Pool falso: guarda la version por usuario en memoria
function poolFalso(usuarios) {
  return {
    query: async (sql, params) => {
      if (sql.startsWith('UPDATE users SET session_version')) {
        const u = usuarios[params[0]];
        u.session_version = (u.session_version || params[1]) + 1;
        return { rows: [{ session_version: u.session_version }] };
      }
      throw new Error('query no simulada: ' + sql);
    }
  };
}

test('un token vale mientras la version del usuario no cambie', async () => {
  const usuarios = { 1: { id: 1, email: 'a@b.c', session_version: 1 } };
  const buscar = async (id) => usuarios[id] || null;
  const tok = firmarToken(usuarios[1], SECRET, '1h');
  const u = await verificarToken(tok, SECRET, buscar);
  assert.equal(u.id, 1);
});

test('revocar deja fuera a los tokens anteriores y el nuevo entra', async () => {
  const usuarios = { 1: { id: 1, email: 'a@b.c', session_version: 1 } };
  const buscar = async (id) => usuarios[id] || null;
  const viejo = firmarToken(usuarios[1], SECRET, '1h');
  const sv = await revocarSesiones(poolFalso(usuarios), 1);
  assert.equal(sv, 2);
  await assert.rejects(verificarToken(viejo, SECRET, buscar), SesionRevocada);
  const nuevo = firmarToken({ ...usuarios[1], session_version: sv }, SECRET, '1h');
  assert.equal((await verificarToken(nuevo, SECRET, buscar)).id, 1);
});

test('tokens emitidos antes de la migracion (sin sv) se toman como version 1', async () => {
  const usuarios = { 1: { id: 1, email: 'a@b.c', session_version: 1 } };
  const buscar = async (id) => usuarios[id] || null;
  const legado = jwt.sign({ id: 1, email: 'a@b.c' }, SECRET, { expiresIn: '1h' });
  assert.equal((await verificarToken(legado, SECRET, buscar)).id, 1, 'sigue valido tras el despliegue');
  await revocarSesiones(poolFalso(usuarios), 1);
  await assert.rejects(verificarToken(legado, SECRET, buscar), SesionRevocada, 'y cae al cambiar la contraseña');
});

test('usuario con session_version NULL (fila anterior a la migracion) equivale a version 1', async () => {
  const usuarios = { 1: { id: 1, email: 'a@b.c', session_version: null } };
  const buscar = async (id) => usuarios[id] || null;
  const tok = firmarToken(usuarios[1], SECRET, '1h');
  assert.equal(jwt.decode(tok).sv, 1);
  assert.equal((await verificarToken(tok, SECRET, buscar)).id, 1);
});

test('token vencido, firma ajena o usuario inexistente siguen fallando como antes', async () => {
  const usuarios = { 1: { id: 1, email: 'a@b.c', session_version: 1 } };
  const buscar = async (id) => usuarios[id] || null;
  const vencido = jwt.sign({ id: 1, sv: 1 }, SECRET, { expiresIn: -10 });
  await assert.rejects(verificarToken(vencido, SECRET, buscar), jwt.TokenExpiredError);
  const ajeno = jwt.sign({ id: 1, sv: 1 }, 'otro-secreto', { expiresIn: '1h' });
  await assert.rejects(verificarToken(ajeno, SECRET, buscar), jwt.JsonWebTokenError);
  const fantasma = jwt.sign({ id: 99, sv: 1 }, SECRET, { expiresIn: '1h' });
  await assert.rejects(verificarToken(fantasma, SECRET, buscar), { code: 'USER_NOT_FOUND' });
});
