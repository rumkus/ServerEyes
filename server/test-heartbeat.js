const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:KuhICZmoKAXRAdzYYlfywJGkIrIHGrKW@yamabiko.proxy.rlwy.net:53691/railway', ssl: { rejectUnauthorized: false } });

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
