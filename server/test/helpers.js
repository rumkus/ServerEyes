// Levanta server.js contra la base de PRUEBAS (TEST_DATABASE_URL) en un
// puerto libre. Sin esa variable los tests que lo usan se saltan.
//
// Nunca usa DATABASE_URL: se pisa a proposito con la de pruebas antes de
// cargar el modulo, y si la de pruebas parece de Railway se aborta.
const http = require('http');

const TEST_DB = process.env.TEST_DATABASE_URL;

function hayBase() { return !!TEST_DB; }

async function levantarServer() {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL no definida');
  if (/rlwy\.net|railway\.app|railway\.internal/i.test(TEST_DB)) throw new Error('TEST_DATABASE_URL apunta a Railway: no');
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-tests-' + 'x'.repeat(32);
  process.env.PORT = '0';
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  delete process.env.SMTP_HOST; delete process.env.SMTP_USER; delete process.env.SMTP_PASS;

  const { app, pool, listo, detener } = require('../server');
  await listo;
  const srv = http.createServer(app);
  // Que las conexiones keep-alive del cliente fetch no demoren el cierre
  srv.keepAliveTimeout = 100;
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;

  const api = async (method, path, { body, token, headers = {} } = {}) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { status: r.status, ok: r.ok, data, headers: r.headers };
  };

  // Limpia lo que crean los tests (todo cuelga de users)
  const limpiar = async () => {
    // CASCADE arrastra heartbeat_log, metrics_history, incidents, shares, etc.
    await pool.query('TRUNCATE users, machines, url_monitors, remote_commands, pending_changes, audit_log RESTART IDENTITY CASCADE');
  };

  // Cierra todo lo que mantiene vivo el proceso: servidor HTTP (y sus
  // conexiones abiertas), temporizadores de la aplicacion, Firebase, pool.
  // Despues de esto el runner termina solo, sin process.exit.
  const cerrar = async () => {
    srv.closeAllConnections();
    await new Promise((resolve, reject) => srv.close(e => e ? reject(e) : resolve()));
    await detener();
  };

  return { api, pool, base, limpiar, cerrar };
}

async function registrar(api, email, password = 'clave123') {
  const r = await api('POST', '/api/auth/register', { body: { email, password, nombre: email.split('@')[0] } });
  if (!r.ok) throw new Error('registro fallo: ' + JSON.stringify(r.data));
  return { token: r.data.token, user: r.data.user, password };
}

module.exports = { hayBase, levantarServer, registrar };
