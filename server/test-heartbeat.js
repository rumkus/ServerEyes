// Prueba manual del UPDATE del heartbeat contra una base de PRUEBAS.
//
// Uso:
//   TEST_DATABASE_URL=postgresql://usuario:clave@localhost:5432/servereyes_test node test-heartbeat.js
//
// La base se toma UNICAMENTE de TEST_DATABASE_URL. A proposito no hay
// fallback a DATABASE_URL: este script existe para probar la consulta, no
// para tocar la base de produccion. Ver .env.example.
//
// La version anterior de este archivo tenia la cadena de conexion de
// produccion escrita adentro y llego a estar en el historial de git. Esa
// credencial hay que rotarla en Railway: sacarla del archivo no la revoca.
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('Falta TEST_DATABASE_URL (base de pruebas). Ejemplo:');
  console.error('  TEST_DATABASE_URL=postgresql://usuario:clave@localhost:5432/servereyes_test node test-heartbeat.js');
  process.exit(1);
}
if (/rlwy\.net|railway\.app|railway\.internal/i.test(url)) {
  console.error('TEST_DATABASE_URL apunta a Railway. Este script es solo para una base de pruebas.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: url,
  ssl: process.env.TEST_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

const query = `UPDATE machines SET
  previous_public_ip = CASE WHEN check_ip_change = true AND public_ip IS NOT NULL AND public_ip != $1 AND (previous_public_ip IS NULL OR previous_public_ip != $1) THEN public_ip ELSE previous_public_ip END,
  ip_changed_at = CASE WHEN check_ip_change = true AND public_ip IS NOT NULL AND public_ip != $1 AND (previous_public_ip IS NULL OR previous_public_ip != $1) THEN NOW() ELSE ip_changed_at END,
  ip_change_seen = CASE WHEN check_ip_change = true AND public_ip IS NOT NULL AND public_ip != $1 AND (previous_public_ip IS NULL OR previous_public_ip != $1) THEN false ELSE ip_change_seen END,
  public_ip = $1, local_ip = $2, os_info = $3, ping_ms = $4,
  cpu_usage = COALESCE($6, cpu_usage), ram_usage = COALESCE($7, ram_usage), ram_total = COALESCE($8, ram_total),
  disk_usage = COALESCE($9, disk_usage), disk_total = COALESCE($10, disk_total),
  agent_version = COALESCE($11, agent_version), disks = COALESCE($12, disks),
  agent_logs = COALESCE($13, agent_logs),
  services = COALESCE($14, services), open_ports = COALESCE($15, open_ports),
  agent_config = COALESCE($16, agent_config),
  last_heartbeat = NOW(), is_online = true, offline_notified = false
WHERE machine_key = $5 RETURNING id`;

const params = ['1.2.3.4', '192.168.1.1', 'test', 3, 'nonexistent_key', 10, 8, 16, 50, 100, '1.0.5', null, null, null, null, null];

pool.query(query, params)
  .then(r => { console.log('OK, rows:', r.rowCount); pool.end(); })
  .catch(e => { console.log('ERROR:', e.message); pool.end(); });
