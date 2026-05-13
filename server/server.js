require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

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
      clerk_id VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255),
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

// ============== MIDDLEWARE AUTH CLERK ==============

async function verifyClerkToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  try {
    // Decodificar JWT de Clerk (verificacion basica)
    const token = authHeader.split(' ')[1];
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());

    // Buscar o crear usuario
    let user = await pool.query('SELECT * FROM users WHERE clerk_id = $1', [payload.sub]);

    if (user.rows.length === 0) {
      user = await pool.query(
        'INSERT INTO users (clerk_id, email) VALUES ($1, $2) RETURNING *',
        [payload.sub, payload.email || '']
      );
    }

    req.user = user.rows[0];
    next();
  } catch (error) {
    console.error('Error de autenticacion:', error);
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
        machine_name = COALESCE($1, machine_name),
        public_ip = $2,
        local_ip = $3,
        os_info = $4,
        last_heartbeat = NOW(),
        is_online = true,
        offline_notified = false
      WHERE machine_key = $5
      RETURNING *`,
      [machine_name, public_ip, local_ip, os_info, machine_key]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Maquina no registrada. Registrala desde la app movil.' });
    }

    // Log del heartbeat
    await pool.query(
      'INSERT INTO heartbeat_log (machine_id, public_ip) VALUES ($1, $2)',
      [result.rows[0].id, public_ip]
    );

    res.json({ status: 'ok', machine: result.rows[0] });
  } catch (error) {
    console.error('Error en heartbeat:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== RUTAS PROTEGIDAS (APP MOVIL) ==============

// Obtener todas las maquinas del usuario
app.get('/api/machines', verifyClerkToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM machines WHERE user_id = $1 ORDER BY machine_name',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener maquinas:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Registrar nueva maquina
app.post('/api/machines', verifyClerkToken, async (req, res) => {
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

// Eliminar maquina
app.delete('/api/machines/:id', verifyClerkToken, async (req, res) => {
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
app.get('/api/machines/:id/history', verifyClerkToken, async (req, res) => {
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

// Endpoint para polling de notificaciones (la app movil consulta periodicamente)
app.get('/api/notifications', verifyClerkToken, async (req, res) => {
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
