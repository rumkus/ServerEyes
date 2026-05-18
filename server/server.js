require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'servereyes-secret-key-change-in-production';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Base de datos
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ============== INICIALIZAR DB ==============

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      clerk_id VARCHAR(255) UNIQUE,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255),
      nombre VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS machines (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      machine_name VARCHAR(255) NOT NULL,
      machine_key VARCHAR(64) UNIQUE NOT NULL,
      public_ip VARCHAR(45),
      local_ip VARCHAR(45),
      os_info TEXT,
      last_heartbeat TIMESTAMP,
      is_online BOOLEAN DEFAULT false,
      offline_notified BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS heartbeat_log (
      id SERIAL PRIMARY KEY,
      machine_id INTEGER REFERENCES machines(id),
      public_ip VARCHAR(45),
      timestamp TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('Base de datos inicializada');
}

// ============== AUTH: REGISTRO Y LOGIN ==============

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, nombre } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y password requeridos' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'El email ya esta registrado' });

    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, nombre) VALUES ($1, $2, $3) RETURNING id, email, nombre',
      [email, password_hash, nombre || '']
    );

    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ user, token });
  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y password requeridos' });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: { id: user.id, email: user.email, nombre: user.nombre }, token });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Login via Clerk (desde la app movil)
app.post('/api/auth/clerk-login', async (req, res) => {
  try {
    const { clerk_id, email } = req.body;
    if (!clerk_id || !email) return res.status(400).json({ error: 'clerk_id y email requeridos' });

    // Buscar usuario por clerk_id o email
    let user = await pool.query('SELECT * FROM users WHERE clerk_id = $1 OR email = $2', [clerk_id, email]);

    if (user.rows.length === 0) {
      // Crear usuario nuevo desde Clerk
      user = await pool.query(
        'INSERT INTO users (clerk_id, email, nombre) VALUES ($1, $2, $3) RETURNING id, email, nombre',
        [clerk_id, email, email.split('@')[0]]
      );
    } else {
      // Actualizar clerk_id si no lo tenia
      if (!user.rows[0].clerk_id) {
        await pool.query('UPDATE users SET clerk_id = $1 WHERE id = $2', [clerk_id, user.rows[0].id]);
      }
    }

    const u = user.rows[0];
    const token = jwt.sign({ id: u.id, email: u.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: { id: u.id, email: u.email, nombre: u.nombre }, token });
  } catch (error) {
    console.error('Error en clerk-login:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== PAIRING (vinculacion por codigo) ==============

// Almacen temporal de codigos de pairing (en memoria, expiran en 5 min)
const pairingCodes = new Map();

// Windows solicita un codigo de pairing
app.post('/api/pairing/request', async (req, res) => {
  try {
    const { machine_name, os_info } = req.body;
    if (!machine_name) return res.status(400).json({ error: 'machine_name requerido' });

    // Generar codigo de 6 digitos
    const code = String(Math.floor(100000 + Math.random() * 900000));

    pairingCodes.set(code, {
      machine_name,
      os_info: os_info || '',
      created_at: Date.now(),
      confirmed: false,
      machine_key: null
    });

    // Limpiar despues de 5 minutos
    setTimeout(() => pairingCodes.delete(code), 5 * 60 * 1000);

    res.json({ code, expires_in: 300 });
  } catch (error) {
    console.error('Error en pairing request:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Android confirma el codigo y crea la maquina
app.post('/api/pairing/confirm', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code requerido' });

    const pairing = pairingCodes.get(code);
    if (!pairing) return res.status(404).json({ error: 'Codigo invalido o expirado' });
    if (pairing.confirmed) return res.status(409).json({ error: 'Codigo ya fue usado' });

    // Crear la maquina
    const machine_key = require('crypto').randomBytes(32).toString('hex').slice(0, 32);
    const result = await pool.query(
      'INSERT INTO machines (user_id, machine_name, machine_key) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, pairing.machine_name, machine_key]
    );

    // Marcar como confirmado
    pairing.confirmed = true;
    pairing.machine_key = machine_key;

    res.json({ machine: result.rows[0] });
  } catch (error) {
    console.error('Error en pairing confirm:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Windows consulta si el codigo fue confirmado
app.get('/api/pairing/status/:code', (req, res) => {
  const pairing = pairingCodes.get(req.params.code);
  if (!pairing) return res.status(404).json({ error: 'Codigo invalido o expirado' });

  if (pairing.confirmed) {
    // Devolver la clave y limpiar
    const machine_key = pairing.machine_key;
    pairingCodes.delete(req.params.code);
    res.json({ confirmed: true, machine_key });
  } else {
    res.json({ confirmed: false });
  }
});

// ============== MIDDLEWARE AUTH JWT ==============

async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await pool.query('SELECT id, email, nombre FROM users WHERE id = $1', [payload.id]);
    if (user.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
    req.user = user.rows[0];
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token invalido' });
  }
}

// ============== RUTAS PUBLICAS (WINDOWS CLIENT) ==============

// Heartbeat desde el cliente Windows
app.post('/api/heartbeat', async (req, res) => {
  try {
    const { machine_key, machine_name, public_ip, local_ip, os_info } = req.body;

    if (!machine_key) {
      return res.status(400).json({ error: 'machine_key es requerido' });
    }

    // Actualizar maquina
    const result = await pool.query(
      `UPDATE machines SET
        previous_public_ip = CASE WHEN public_ip IS NOT NULL AND public_ip != $1 THEN public_ip ELSE previous_public_ip END,
        ip_changed_at = CASE WHEN public_ip IS NOT NULL AND public_ip != $1 THEN NOW() ELSE ip_changed_at END,
        ip_change_seen = CASE WHEN public_ip IS NOT NULL AND public_ip != $1 THEN false ELSE ip_change_seen END,
        public_ip = $1,
        local_ip = $2,
        os_info = $3,
        last_heartbeat = NOW(),
        is_online = true,
        offline_notified = false
      WHERE machine_key = $4
      RETURNING *`,
      [public_ip, local_ip, os_info, machine_key]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Maquina no registrada. Registrala desde la app movil.' });
    }

    // Log del heartbeat
    await pool.query(
      'INSERT INTO heartbeat_log (machine_id, public_ip) VALUES ($1, $2)',
      [result.rows[0].id, public_ip]
    );

    // Registrar cambio a online si estaba offline
    const updatedMachine = result.rows[0];
    if (updatedMachine) {
      // Chequeamos si es la primera vez o si estaba offline antes
      const lastLog = await pool.query(
        'SELECT status FROM uptime_log WHERE machine_id = $1 ORDER BY timestamp DESC LIMIT 1',
        [updatedMachine.id]
      );
      if (lastLog.rows.length === 0 || lastLog.rows[0].status === 'offline') {
        await pool.query('INSERT INTO uptime_log (machine_id, status) VALUES ($1, $2)', [updatedMachine.id, 'online']);
      }
    }

    // Auto-update DNS si cambio la IP y tiene URL configurada
    const updatedMachine = result.rows[0];
    if (updatedMachine.dns_update_url && updatedMachine.previous_public_ip &&
        updatedMachine.previous_public_ip !== public_ip) {
      try {
        const dnsUrl = `${updatedMachine.dns_update_url}&address=${public_ip}`;
        const dnsClient = dnsUrl.startsWith('https') ? require('https') : require('http');
        dnsClient.get(dnsUrl, (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => {
            console.log(`[DNS] Auto-update ${updatedMachine.dns_host || 'host'}: ${d.trim()}`);
            pool.query('UPDATE machines SET dns_last_update = NOW() WHERE id = $1', [updatedMachine.id]);
          });
        });
      } catch (e) { console.error('[DNS] Auto-update error:', e.message); }
    }

    res.json({ status: 'ok', machine: result.rows[0] });
  } catch (error) {
    console.error('Error en heartbeat:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== RUTAS PROTEGIDAS (APP MOVIL) ==============

// Obtener todas las maquinas del usuario
app.get('/api/machines', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM machines WHERE user_id = $1 ORDER BY grupo NULLS LAST, orden, machine_name',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener maquinas:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Registrar nueva maquina
app.post('/api/machines', authenticateToken, async (req, res) => {
  try {
    const { machine_name } = req.body;

    if (!machine_name) {
      return res.status(400).json({ error: 'machine_name es requerido' });
    }

    // Generar clave unica para la maquina
    const machine_key = require('crypto').randomBytes(32).toString('hex').slice(0, 32);

    const result = await pool.query(
      'INSERT INTO machines (user_id, machine_name, machine_key) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, machine_name, machine_key]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al registrar maquina:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Actualizar maquina (nombre, grupo, orden)
app.put('/api/machines/:id', authenticateToken, async (req, res) => {
  try {
    const { machine_name, grupo, orden, dns_update_url, dns_host } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;

    if (machine_name !== undefined) { fields.push(`machine_name = $${idx++}`); values.push(machine_name); }
    if (grupo !== undefined) { fields.push(`grupo = $${idx++}`); values.push(grupo || null); }
    if (orden !== undefined) { fields.push(`orden = $${idx++}`); values.push(orden); }
    if (dns_update_url !== undefined) { fields.push(`dns_update_url = $${idx++}`); values.push(dns_update_url || null); }
    if (dns_host !== undefined) { fields.push(`dns_host = $${idx++}`); values.push(dns_host || null); }

    if (fields.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

    values.push(req.params.id, req.user.id);
    const result = await pool.query(
      `UPDATE machines SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar maquina:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Actualizar orden de varias maquinas
app.put('/api/machines-order', authenticateToken, async (req, res) => {
  try {
    const { orders } = req.body; // [{id: 1, orden: 0, grupo: 'Cliente A'}, ...]
    for (const item of orders) {
      await pool.query(
        'UPDATE machines SET orden = $1, grupo = $2 WHERE id = $3 AND user_id = $4',
        [item.orden, item.grupo || null, item.id, req.user.id]
      );
    }
    res.json({ message: 'Orden actualizado' });
  } catch (error) {
    console.error('Error al actualizar orden:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Actualizar DNS de una maquina (FreeDNS)
app.post('/api/machines/:id/update-dns', authenticateToken, async (req, res) => {
  try {
    const machine = await pool.query(
      'SELECT * FROM machines WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });

    const m = machine.rows[0];
    if (!m.dns_update_url) return res.status(400).json({ error: 'No tiene URL de DNS configurada' });
    if (!m.public_ip) return res.status(400).json({ error: 'La maquina no tiene IP publica' });

    // Llamar a FreeDNS con la IP actual
    const updateUrl = m.dns_update_url.includes('&address=')
      ? m.dns_update_url
      : `${m.dns_update_url}&address=${m.public_ip}`;

    const https = require('https');
    const http = require('http');
    const result = await new Promise((resolve, reject) => {
      const client = updateUrl.startsWith('https') ? https : http;
      client.get(updateUrl, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      }).on('error', reject);
    });

    await pool.query('UPDATE machines SET dns_last_update = NOW() WHERE id = $1', [m.id]);

    res.json({ message: 'DNS actualizado', result, ip: m.public_ip, host: m.dns_host });
  } catch (error) {
    console.error('Error al actualizar DNS:', error);
    res.status(500).json({ error: 'Error al actualizar DNS' });
  }
});

// Eliminar maquina
app.delete('/api/machines/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM heartbeat_log WHERE machine_id = $1',
      [req.params.id]
    );
    await pool.query(
      'DELETE FROM machines WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Maquina eliminada' });
  } catch (error) {
    console.error('Error al eliminar maquina:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Obtener historial de heartbeats de una maquina
app.get('/api/machines/:id/history', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT h.* FROM heartbeat_log h
       JOIN machines m ON h.machine_id = m.id
       WHERE m.id = $1 AND m.user_id = $2
       ORDER BY h.timestamp DESC LIMIT 100`,
      [req.params.id, req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener historial:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== DETECTOR DE OFFLINE ==============

// Cada 30 segundos, marcar maquinas sin heartbeat en 60s como offline
setInterval(async () => {
  try {
    const offlineMachines = await pool.query(
      `UPDATE machines SET is_online = false
       WHERE is_online = true
       AND last_heartbeat < NOW() - INTERVAL '60 seconds'
       RETURNING *`
    );

    for (const machine of offlineMachines.rows) {
      if (!machine.offline_notified) {
        console.log(`[OFFLINE] ${machine.machine_name} (${machine.public_ip})`);
        await pool.query('INSERT INTO uptime_log (machine_id, status) VALUES ($1, $2)', [machine.id, 'offline']);
        await pool.query(
          'UPDATE machines SET offline_notified = true WHERE id = $1',
          [machine.id]
        );
      }
    }
  } catch (error) {
    console.error('Error en detector offline:', error);
  }
}, 30000);

// ============== RUTA DE ESTADO ==============

app.get('/api/status', (req, res) => {
  res.json({ status: 'ServerEyes running', timestamp: new Date().toISOString() });
});

// Historial de uptime de una maquina (ultimos N dias)
app.get('/api/machines/:id/uptime', authenticateToken, async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const machine = await pool.query('SELECT id FROM machines WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });

    // Obtener eventos de uptime
    const events = await pool.query(
      `SELECT status, timestamp FROM uptime_log
       WHERE machine_id = $1 AND timestamp > NOW() - INTERVAL '1 day' * $2
       ORDER BY timestamp ASC`,
      [req.params.id, days]
    );

    // Calcular uptime por dia
    const dailyUptime: any = {};
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const key = date.toISOString().split('T')[0];
      dailyUptime[key] = { date: key, online_minutes: 0, offline_minutes: 0, total_minutes: 1440, percentage: 0 };
    }

    // Procesar eventos para calcular minutos online/offline por dia
    let lastStatus = 'offline';
    let lastTime = new Date(now.getTime() - days * 86400000);

    for (const event of events.rows) {
      const eventTime = new Date(event.timestamp);
      const diffMinutes = (eventTime.getTime() - lastTime.getTime()) / 60000;

      // Distribuir minutos entre dias
      let remaining = diffMinutes;
      let cursor = new Date(lastTime);
      while (remaining > 0) {
        const dayKey = cursor.toISOString().split('T')[0];
        const endOfDay = new Date(cursor);
        endOfDay.setHours(23, 59, 59, 999);
        const minutesInDay = Math.min(remaining, (endOfDay.getTime() - cursor.getTime()) / 60000);

        if (dailyUptime[dayKey]) {
          if (lastStatus === 'online') dailyUptime[dayKey].online_minutes += minutesInDay;
          else dailyUptime[dayKey].offline_minutes += minutesInDay;
        }

        remaining -= minutesInDay;
        cursor = new Date(endOfDay.getTime() + 1);
      }

      lastStatus = event.status;
      lastTime = eventTime;
    }

    // Desde el ultimo evento hasta ahora
    const finalDiff = (now.getTime() - lastTime.getTime()) / 60000;
    let remaining = finalDiff;
    let cursor = new Date(lastTime);
    while (remaining > 0) {
      const dayKey = cursor.toISOString().split('T')[0];
      const endOfDay = new Date(cursor);
      endOfDay.setHours(23, 59, 59, 999);
      const minutesInDay = Math.min(remaining, (endOfDay.getTime() - cursor.getTime()) / 60000);

      if (dailyUptime[dayKey]) {
        if (lastStatus === 'online') dailyUptime[dayKey].online_minutes += minutesInDay;
        else dailyUptime[dayKey].offline_minutes += minutesInDay;
      }

      remaining -= minutesInDay;
      cursor = new Date(endOfDay.getTime() + 1);
    }

    // Calcular porcentajes
    const result = Object.values(dailyUptime).map((d: any) => {
      const total = d.online_minutes + d.offline_minutes;
      d.percentage = total > 0 ? Math.round((d.online_minutes / total) * 100) : 0;
      return d;
    });

    res.json(result);
  } catch (error) {
    console.error('Error en uptime:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Endpoint para cambios de IP no vistos
app.get('/api/ip-changes', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, machine_name, public_ip, previous_public_ip, ip_changed_at
       FROM machines
       WHERE user_id = $1 AND ip_change_seen = false`,
      [req.user.id]
    );

    // Marcar como vistos
    if (result.rows.length > 0) {
      await pool.query(
        'UPDATE machines SET ip_change_seen = true WHERE user_id = $1 AND ip_change_seen = false',
        [req.user.id]
      );
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener cambios de IP:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Endpoint para polling de notificaciones (la app movil consulta periodicamente)
app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, machine_name, public_ip, last_heartbeat, is_online
       FROM machines
       WHERE user_id = $1 AND is_online = false AND offline_notified = true
       ORDER BY last_heartbeat DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener notificaciones:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== INICIAR SERVIDOR ==============

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`ServerEyes backend corriendo en puerto ${PORT}`);
  });
}).catch(err => {
  console.error('Error al inicializar DB:', err);
  process.exit(1);
});
