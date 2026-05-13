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
app.get('/api/machines', authenticateToken, async (req, res) => {
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
