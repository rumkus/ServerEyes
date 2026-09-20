// Sesiones con version por usuario.
//
// Un JWT firmado vale hasta que vence, y cambiar la contraseña no lo tocaba:
// quien tuviera un token viejo seguia adentro aunque el dueño de la cuenta
// acabara de cambiarla justamente para sacarlo. Ahora cada token lleva la
// session_version del usuario al momento de emitirlo, y cada request la compara
// con la actual. Subir la version (cambio de contraseña, reseteo por el admin,
// "cerrar todas las sesiones") deja fuera a todos los tokens anteriores.
//
// Los tokens emitidos antes de esta version no traen "sv": se los toma como
// version 1, que es con la que arranca cada usuario en la migracion. Asi nadie
// pierde la sesion por el despliegue, y en cuanto cambie su contraseña esos
// tokens viejos tambien quedan fuera.
const jwt = require('jsonwebtoken');

const VERSION_INICIAL = 1;

class SesionRevocada extends Error {
  constructor() { super('Sesion revocada'); this.name = 'SesionRevocada'; this.code = 'SESSION_REVOKED'; }
}

function firmarToken(user, secret, expiresIn) {
  return jwt.sign(
    { id: user.id, email: user.email, sv: user.session_version || VERSION_INICIAL },
    secret,
    { expiresIn: expiresIn || '30d' }
  );
}

// buscarUsuario(id) -> fila con session_version (o null si no existe).
// Devuelve la fila, o lanza: jwt.* si el token es invalido/vencido,
// SesionRevocada si la version no coincide, Error('Usuario no encontrado').
async function verificarToken(token, secret, buscarUsuario) {
  const payload = jwt.verify(token, secret);
  const user = await buscarUsuario(payload.id);
  if (!user) { const e = new Error('Usuario no encontrado'); e.code = 'USER_NOT_FOUND'; throw e; }
  const enToken = payload.sv === undefined ? VERSION_INICIAL : payload.sv;
  const actual = user.session_version || VERSION_INICIAL;
  if (enToken !== actual) throw new SesionRevocada();
  return user;
}

// Sube la version y devuelve la nueva. Con eso se puede emitir en el mismo
// paso un token fresco para quien hizo el cambio.
async function revocarSesiones(pool, userId) {
  const r = await pool.query(
    'UPDATE users SET session_version = COALESCE(session_version, $2) + 1 WHERE id = $1 RETURNING session_version',
    [userId, VERSION_INICIAL]
  );
  return r.rows[0] ? r.rows[0].session_version : null;
}

module.exports = { firmarToken, verificarToken, revocarSesiones, SesionRevocada, VERSION_INICIAL };
