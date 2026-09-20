// Migracion de remote_commands (TEST_DATABASE_URL): base vacia, base con el
// esquema intermedio (indice parcial por pending) y comandos existentes,
// preservacion de datos y repeticion de la migracion.
//
// Se prepara el esquema ANTES de cargar server.js (que corre initDB al
// importarse), con una conexion propia a la misma base de pruebas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hayBase } = require('./helpers');

const skip = !hayBase() ? 'TEST_DATABASE_URL no definida: se salta la migracion' : false;
const TEST_DB = process.env.TEST_DATABASE_URL;

let prep, S;
before(async () => {
  if (skip) return;
  if (/rlwy\.net|railway\.app|railway\.internal/i.test(TEST_DB)) throw new Error('TEST_DATABASE_URL apunta a Railway: no');
  const { Pool } = require('pg');
  prep = new Pool({ connectionString: TEST_DB });
  // Esquema intermedio: lo minimo que aquella version dejaba en la base.
  await prep.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await prep.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255), nombre VARCHAR(255), created_at TIMESTAMP DEFAULT NOW())`);
  await prep.query(`CREATE TABLE machines (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), machine_name VARCHAR(255) NOT NULL, machine_key VARCHAR(64) UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  await prep.query(`CREATE TABLE remote_commands (
    id SERIAL PRIMARY KEY, machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id),
    command TEXT NOT NULL, status VARCHAR(20) DEFAULT 'pending', output TEXT, created_at TIMESTAMP DEFAULT NOW(), executed_at TIMESTAMP,
    delivered_at TIMESTAMP, delivery_count INTEGER DEFAULT 0, retry_of INTEGER)`);
  await prep.query(`CREATE UNIQUE INDEX remote_commands_reenvio_pendiente ON remote_commands (retry_of) WHERE status = 'pending' AND retry_of IS NOT NULL`);
  await prep.query(`INSERT INTO users (email, password_hash, nombre) VALUES ('mig@test.local', 'x', 'mig')`);
  await prep.query(`INSERT INTO machines (user_id, machine_name, machine_key) VALUES (1, 'pc', 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk')`);
  // Comandos de la version intermedia: original delivered, un reenvio completed y otro pending
  await prep.query(`INSERT INTO remote_commands (machine_id, user_id, command, status, delivery_count) VALUES (1, 1, 'echo original', 'delivered', 1)`);
  await prep.query(`INSERT INTO remote_commands (machine_id, user_id, command, status, output, retry_of, delivery_count) VALUES (1, 1, 'echo original', 'completed', 'ok', 1, 1)`);
  await prep.query(`INSERT INTO remote_commands (machine_id, user_id, command, status, retry_of) VALUES (1, 1, 'echo original', 'pending', 1)`);
  await prep.query(`INSERT INTO remote_commands (machine_id, user_id, command, status) VALUES (1, 1, 'echo otro', 'pending')`);
});
after(async () => { if (prep) await prep.end(); if (S) await S.cerrar(); });

const indices = (pool) => pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'remote_commands' ORDER BY indexname`).then(r => r.rows.map(x => x.indexname));
const columnas = (pool) => pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'remote_commands' ORDER BY column_name`).then(r => r.rows.map(x => x.column_name));

test('esquema intermedio: initDB retira el indice viejo, crea el de idempotencia y conserva las filas', { skip }, async () => {
  const antes = await indices(prep);
  assert.ok(antes.includes('remote_commands_reenvio_pendiente'), 'precondicion: el indice intermedio existe');
  assert.ok(!(await columnas(prep)).includes('idem_key'));

  const { levantarServer } = require('./helpers');
  S = await levantarServer(); // require('../server') + initDB
  const { pool } = S;

  const despues = await indices(pool);
  assert.ok(!despues.includes('remote_commands_reenvio_pendiente'), 'indice intermedio retirado');
  assert.ok(despues.includes('remote_commands_reenvio_idem'), 'indice de idempotencia creado');
  assert.ok((await columnas(pool)).includes('idem_key'));

  const filas = (await pool.query('SELECT id, command, status, output, retry_of, delivery_count, idem_key FROM remote_commands ORDER BY id')).rows;
  assert.deepEqual(filas, [
    { id: 1, command: 'echo original', status: 'delivered', output: null, retry_of: null, delivery_count: 1, idem_key: null },
    { id: 2, command: 'echo original', status: 'completed', output: 'ok', retry_of: 1, delivery_count: 1, idem_key: null },
    { id: 3, command: 'echo original', status: 'pending', output: null, retry_of: 1, delivery_count: 0, idem_key: null },
    { id: 4, command: 'echo otro', status: 'pending', output: null, retry_of: null, delivery_count: 0, idem_key: null }
  ], 'las filas de la version intermedia se preservan tal cual');

  // Sin el indice viejo, un segundo reenvio deliberado pendiente del mismo original es posible
  await pool.query(`INSERT INTO remote_commands (machine_id, user_id, command, status, retry_of, idem_key) VALUES (1, 1, 'echo original', 'pending', 1, 'clave-nueva-1')`);
  // Y el indice nuevo si rechaza la misma clave del mismo usuario sobre el mismo original
  await assert.rejects(
    pool.query(`INSERT INTO remote_commands (machine_id, user_id, command, status, retry_of, idem_key) VALUES (1, 1, 'echo original', 'pending', 1, 'clave-nueva-1')`),
    { code: '23505' }
  );
});

test('repetir la migracion es inocuo (idempotente)', { skip }, async () => {
  const { pool } = S;
  const antesIdx = await indices(pool);
  const antesCols = await columnas(pool);
  const antesFilas = (await pool.query('SELECT count(*)::int AS n FROM remote_commands')).rows[0].n;
  // Mismas sentencias que initDB para remote_commands, otra vez
  await pool.query(`ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP`);
  await pool.query(`ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS delivery_count INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS retry_of INTEGER`);
  await pool.query(`ALTER TABLE remote_commands ADD COLUMN IF NOT EXISTS idem_key VARCHAR(64)`);
  await pool.query(`DROP INDEX IF EXISTS remote_commands_reenvio_pendiente`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS remote_commands_reenvio_idem ON remote_commands (user_id, retry_of, idem_key) WHERE idem_key IS NOT NULL`);
  assert.deepEqual(await indices(pool), antesIdx);
  assert.deepEqual(await columnas(pool), antesCols);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM remote_commands')).rows[0].n, antesFilas);
});

test('base vacia: el esquema final queda igual que tras migrar el intermedio', { skip }, async () => {
  const { pool } = S;
  const idxMigrado = await indices(pool);
  const colsMigrado = await columnas(pool);
  // Base vacia de verdad: se borra todo y se vuelve a correr initDB
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  // initDB no esta exportado; se reutiliza el modulo: pool.query de las mismas
  // sentencias que ejecuta al arrancar. Para no duplicarlas aca, se vuelve a
  // cargar server.js en un proceso hijo contra la misma base.
  const { execFile } = require('child_process');
  // El hijo no debe heredar el contexto del test runner (NODE_TEST_CONTEXT):
  // si lo hereda, node lo trata como otro proceso de tests y corta el reporte
  // de este archivo (los tests que siguen ni aparecen).
  const envHijo = { ...process.env }; delete envHijo.NODE_TEST_CONTEXT; delete envHijo.NODE_OPTIONS;
  await new Promise((resolve, reject) => execFile(process.execPath, ['-e', `
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; process.env.NODE_ENV = 'test'; process.env.PORT = '0';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-tests-' + 'x'.repeat(32);
    const s = require(${JSON.stringify(require.resolve('../server'))});
    // Sin process.exit: con los temporizadores cancelados y el pool cerrado, el proceso termina solo.
    s.listo.then(() => s.detener()).catch((e) => { console.error(e); process.exitCode = 1; });
  `], { env: envHijo, timeout: 60000 }, (err, stdout, stderr) => err ? reject(new Error('initDB en proceso hijo fallo: ' + err.message + (stderr ? ' | ' + stderr.trim() : ''))) : resolve()));
  assert.deepEqual(await indices(pool), idxMigrado);
  assert.deepEqual(await columnas(pool), colsMigrado);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM remote_commands')).rows[0].n, 0);
});
