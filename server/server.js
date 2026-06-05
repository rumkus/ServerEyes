require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const JWT_SECRET = process.env.JWT_SECRET || 'servereyes-secret-key-change-in-production';

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (no crash):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection (no crash):', reason);
});

// Email (Nodemailer)
let emailTransporter = null;
try {
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_HOST) {
    emailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    console.log('Email configurado:', process.env.SMTP_USER);
  } else if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    // Gmail shortcut
    emailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    console.log('Email Gmail configurado:', process.env.SMTP_USER);
  } else {
    console.log('Email no configurado (faltan SMTP_HOST o SMTP_USER/SMTP_PASS)');
  }
} catch (err) {
  console.error('Error configurando email:', err.message);
}

async function sendEmail(to, subject, body) {
  if (!emailTransporter) return;
  try {
    await emailTransporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'servereyes@noreply.com',
      to,
      subject: '[ServerEyes] ' + subject,
      html: `<div style="font-family:Arial,sans-serif;padding:20px;background:#f5f5f5">
        <div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
          <h2 style="color:#2196F3;margin:0 0 16px">👁 ServerEyes</h2>
          ${body}
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <p style="color:#999;font-size:11px;margin:0">Notificacion automatica de ServerEyes</p>
        </div>
      </div>`
    });
    console.log(`[EMAIL] Enviado a ${to}: ${subject}`);
  } catch (err) {
    console.error(`[EMAIL] Error enviando a ${to}:`, err.message);
  }
}

async function sendEmailWithUserSMTP(user, subject, htmlBody) {
  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport(user.smtp_host ? {
      host: user.smtp_host, port: user.smtp_port || 587, secure: user.smtp_secure || false,
      auth: { user: user.smtp_user, pass: user.smtp_pass }
    } : { service: 'gmail', auth: { user: user.smtp_user, pass: user.smtp_pass } });

    await transport.sendMail({
      from: user.smtp_from || user.smtp_user,
      to: user.email,
      subject: '[ServerEyes] ' + subject,
      html: `<div style="font-family:Arial,sans-serif;padding:20px;background:#f5f5f5">
        <div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
          <h2 style="color:#2196F3;margin:0 0 16px">👁 ServerEyes</h2>
          ${htmlBody}
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <p style="color:#999;font-size:11px;margin:0">Notificacion automatica de ServerEyes</p>
        </div>
      </div>`
    });
    console.log(`[EMAIL-USER] Enviado a ${user.email}: ${subject}`);
  } catch (err) {
    console.error(`[EMAIL-USER] Error enviando a ${user.email}:`, err.message);
  }
}

// Firebase Admin
let firebaseAdmin = null;
try {
  const admin = require('firebase-admin');
  const fs = require('fs');
  const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');
  let serviceAccount = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (parseErr) {
      console.error('FIREBASE_SERVICE_ACCOUNT JSON invalido:', parseErr.message);
      console.error('Primeros 100 chars:', process.env.FIREBASE_SERVICE_ACCOUNT.substring(0, 100));
    }
  } else if (fs.existsSync(serviceAccountPath)) {
    serviceAccount = require(serviceAccountPath);
  }

  if (serviceAccount) {
    const requiredFields = ['project_id', 'private_key', 'client_email'];
    const missing = requiredFields.filter(f => !serviceAccount[f]);
    if (missing.length > 0) {
      console.error('FIREBASE_SERVICE_ACCOUNT incompleto, faltan:', missing.join(', '));
    } else {
      console.log('Firebase SA: project=' + serviceAccount.project_id + ', email=' + serviceAccount.client_email);
      if (!serviceAccount.private_key.includes('BEGIN PRIVATE KEY')) {
        console.error('Firebase private_key no tiene formato PEM valido');
      }
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      firebaseAdmin = admin;
      console.log('Firebase Admin inicializado');
    }
  } else {
    console.log('Firebase no configurado, push deshabilitado');
  }
} catch (err) {
  console.error('Error inicializando Firebase:', err.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/classic', (req, res) => res.sendFile(path.join(__dirname, 'public', 'classic.html')));

// Base de datos
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});

pool.on('error', (err) => {
  console.error('[DB Pool] Unexpected error on idle client:', err.message);
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ip_history (
      id SERIAL PRIMARY KEY,
      machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE,
      public_ip VARCHAR(45) NOT NULL,
      previous_ip VARCHAR(45),
      changed_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Agregar columnas nuevas si no existen
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS check_ip_change BOOLEAN DEFAULT true`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS cpu_usage REAL`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS ram_usage REAL`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS ram_total REAL`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS disk_usage REAL`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS disk_total REAL`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS disks JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS monitored_disks JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS alert_disks JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS agent_logs TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS services JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS open_ports JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS agent_config JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS config_backup_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS backup_status JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS backup_alert_sent BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS check_backup_pending BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS rdp_port INTEGER DEFAULT 3389`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS rdp_user VARCHAR(100)`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS geo_city VARCHAR(100)`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS geo_region VARCHAR(100)`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS geo_country VARCHAR(100)`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS geo_lat REAL`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS geo_lon REAL`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS geo_manual BOOLEAN DEFAULT false`).catch(() => {});

  // Historial de metricas (1 registro por heartbeat, limpieza automatica)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metrics_history (
      id SERIAL PRIMARY KEY,
      machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE,
      cpu_usage REAL,
      ram_usage REAL,
      ram_total REAL,
      disks JSONB,
      ping_ms INTEGER,
      timestamp TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_metrics_machine_time ON metrics_history (machine_id, timestamp DESC)`).catch(() => {});

  // Comandos remotos
  await pool.query(`
    CREATE TABLE IF NOT EXISTS remote_commands (
      id SERIAL PRIMARY KEY,
      machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      command TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      output TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      executed_at TIMESTAMP
    )
  `);
  // Umbrales de alerta (null = desactivado)
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS alert_cpu INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS alert_ram INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS alert_disk INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS alert_ping INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS alert_offline BOOLEAN DEFAULT true`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS last_alert_at TIMESTAMP`).catch(() => {});

  // Tabla de configuracion general
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key VARCHAR(50) PRIMARY KEY,
      value TEXT
    )
  `);
  // Columna para que cada maquina reporte su version
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS agent_version VARCHAR(20)`).catch(() => {});
  // Admin flag
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications BOOLEAN DEFAULT true`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_host VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_port INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_secure BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_user VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_pass VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_from VARCHAR(255)`).catch(() => {});
  // Hacer admin al primer usuario
  await pool.query(`UPDATE users SET is_admin = true WHERE id = 1 AND is_admin = false`).catch(() => {});
  // Tabla para almacenar archivo del agente
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_files (
      id SERIAL PRIMARY KEY,
      version VARCHAR(20) NOT NULL,
      filename VARCHAR(255),
      file_data BYTEA,
      file_size INTEGER,
      changelog TEXT DEFAULT '',
      uploaded_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Organizacion / empresa
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES users(id),
      name VARCHAR(255) NOT NULL,
      address TEXT DEFAULT '',
      phone VARCHAR(50) DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'owner'`).catch(() => {});

  // Invitaciones
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invitations (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      invited_by INTEGER REFERENCES users(id),
      email VARCHAR(255) NOT NULL,
      code VARCHAR(10) UNIQUE NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Compartir maquinas con tecnicos
  await pool.query(`
    CREATE TABLE IF NOT EXISTS machine_shares (
      id SERIAL PRIMARY KEY,
      machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      shared_by INTEGER REFERENCES users(id),
      can_edit BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(machine_id, user_id)
    )
  `);

  // Audit log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      action VARCHAR(100) NOT NULL,
      target_type VARCHAR(50),
      target_id INTEGER,
      details TEXT,
      ip VARCHAR(45),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_log (user_id, created_at DESC)`).catch(() => {});

  // Maintenance windows
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE,
      title VARCHAR(255) DEFAULT 'Mantenimiento',
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP NOT NULL,
      repeat VARCHAR(20) DEFAULT 'none',
      suppress_alerts BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // URL/HTTP monitoring
  await pool.query(`
    CREATE TABLE IF NOT EXISTS url_monitors (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      url VARCHAR(500) NOT NULL,
      name VARCHAR(255),
      method VARCHAR(10) DEFAULT 'GET',
      expected_status INTEGER DEFAULT 200,
      timeout_ms INTEGER DEFAULT 10000,
      interval_seconds INTEGER DEFAULT 300,
      is_active BOOLEAN DEFAULT true,
      last_status INTEGER,
      last_response_ms INTEGER,
      last_check TIMESTAMP,
      last_error TEXT,
      is_up BOOLEAN DEFAULT true,
      down_since TIMESTAMP,
      notify_down BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      sender_id INTEGER REFERENCES users(id),
      target VARCHAR(20) DEFAULT 'all',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_reads (
      id SERIAL PRIMARY KEY,
      notification_id INTEGER REFERENCES admin_notifications(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      read_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(notification_id, user_id)
    )
  `);

  // Wake-on-LAN
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS mac_address VARCHAR(17)`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS wol_broadcast VARCHAR(45) DEFAULT '255.255.255.255'`).catch(() => {});

  console.log('Base de datos inicializada');
}

// Audit helper
async function logAudit(userId, action, targetType, targetId, details, ip) {
  try {
    await pool.query(
      'INSERT INTO audit_log (user_id, action, target_type, target_id, details, ip) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, action, targetType || null, targetId || null, details || null, ip || null]
    );
  } catch {}
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
    logAudit(user.id, 'register', 'user', user.id, null, req.ip);
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
    logAudit(user.id, 'login', 'user', user.id, null, req.ip);
    res.json({ user: { id: user.id, email: user.email, nombre: user.nombre, organization_id: user.organization_id, role: user.role || 'owner' }, token });
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

// Cambiar contraseña
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Ambas contraseñas son requeridas' });
    if (new_password.length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });

    const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    const valid = await bcrypt.compare(current_password, user.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);
    res.json({ message: 'Contraseña actualizada' });
  } catch (error) {
    console.error('Error al cambiar contraseña:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== ORGANIZACION Y EQUIPO ==============

// Crear o actualizar organizacion
app.post('/api/organization', authenticateToken, async (req, res) => {
  try {
    const { name, address, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre de empresa requerido' });

    // Chequear si ya tiene org
    const existing = await pool.query('SELECT id FROM organizations WHERE owner_id = $1', [req.user.id]);
    if (existing.rows.length > 0) {
      await pool.query('UPDATE organizations SET name = $1, address = $2, phone = $3 WHERE owner_id = $4', [name, address || '', phone || '', req.user.id]);
      res.json({ message: 'Organizacion actualizada', id: existing.rows[0].id });
    } else {
      const result = await pool.query(
        'INSERT INTO organizations (owner_id, name, address, phone) VALUES ($1, $2, $3, $4) RETURNING id',
        [req.user.id, name, address || '', phone || '']
      );
      await pool.query('UPDATE users SET organization_id = $1, role = $2 WHERE id = $3', [result.rows[0].id, 'owner', req.user.id]);
      res.json({ message: 'Organizacion creada', id: result.rows[0].id });
    }
  } catch (error) {
    console.error('Error en organizacion:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Obtener mi organizacion y equipo
app.get('/api/organization', authenticateToken, async (req, res) => {
  try {
    // Buscar org donde soy owner
    let org = await pool.query('SELECT * FROM organizations WHERE owner_id = $1', [req.user.id]);
    // Si no soy owner, buscar por organization_id
    if (org.rows.length === 0) {
      const user = await pool.query('SELECT organization_id FROM users WHERE id = $1', [req.user.id]);
      if (user.rows[0]?.organization_id) {
        org = await pool.query('SELECT * FROM organizations WHERE id = $1', [user.rows[0].organization_id]);
      }
    }
    if (org.rows.length === 0) return res.json({ organization: null, team: [], invitations: [] });

    const orgId = org.rows[0].id;
    const team = await pool.query(
      'SELECT id, email, nombre, role, created_at FROM users WHERE organization_id = $1 ORDER BY role, id',
      [orgId]
    );
    const invitations = await pool.query(
      'SELECT i.*, u.email as invited_by_email FROM invitations i LEFT JOIN users u ON i.invited_by = u.id WHERE i.organization_id = $1 ORDER BY i.created_at DESC',
      [orgId]
    );
    res.json({ organization: org.rows[0], team: team.rows, invitations: invitations.rows });
  } catch (error) {
    console.error('Error obteniendo organizacion:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Invitar tecnico
app.post('/api/organization/invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requerido' });

    const org = await pool.query('SELECT id FROM organizations WHERE owner_id = $1', [req.user.id]);
    if (org.rows.length === 0) return res.status(400).json({ error: 'Primero crea tu organizacion' });

    // Chequear si ya fue invitado
    const existing = await pool.query('SELECT id FROM invitations WHERE organization_id = $1 AND email = $2 AND status = $3', [org.rows[0].id, email, 'pending']);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Ya hay una invitacion pendiente para ese email' });

    const code = require('crypto').randomBytes(4).toString('hex').toUpperCase();
    await pool.query(
      'INSERT INTO invitations (organization_id, invited_by, email, code) VALUES ($1, $2, $3, $4)',
      [org.rows[0].id, req.user.id, email, code]
    );
    res.json({ message: 'Invitacion creada', code });
  } catch (error) {
    console.error('Error invitando:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Aceptar invitacion (el tecnico usa el codigo)
app.post('/api/organization/join', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Codigo requerido' });

    const inv = await pool.query('SELECT * FROM invitations WHERE code = $1 AND status = $2', [code.toUpperCase(), 'pending']);
    if (inv.rows.length === 0) return res.status(404).json({ error: 'Codigo invalido o ya fue usado' });

    const invitation = inv.rows[0];
    // Verificar que el email coincide
    const user = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    if (user.rows[0].email !== invitation.email) {
      return res.status(403).json({ error: 'Este codigo es para ' + invitation.email });
    }

    await pool.query('UPDATE users SET organization_id = $1, role = $2 WHERE id = $3', [invitation.organization_id, 'technician', req.user.id]);
    await pool.query('UPDATE invitations SET status = $1 WHERE id = $2', ['accepted', invitation.id]);

    const org = await pool.query('SELECT name FROM organizations WHERE id = $1', [invitation.organization_id]);
    res.json({ message: 'Te uniste a ' + org.rows[0].name, organization_id: invitation.organization_id });
  } catch (error) {
    console.error('Error aceptando invitacion:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Cancelar invitacion
app.delete('/api/organization/invite/:id', authenticateToken, async (req, res) => {
  try {
    const org = await pool.query('SELECT id FROM organizations WHERE owner_id = $1', [req.user.id]);
    if (org.rows.length === 0) return res.status(403).json({ error: 'No autorizado' });
    await pool.query('DELETE FROM invitations WHERE id = $1 AND organization_id = $2', [req.params.id, org.rows[0].id]);
    res.json({ message: 'Invitacion cancelada' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Remover tecnico del equipo
app.delete('/api/organization/member/:id', authenticateToken, async (req, res) => {
  try {
    const org = await pool.query('SELECT id FROM organizations WHERE owner_id = $1', [req.user.id]);
    if (org.rows.length === 0) return res.status(403).json({ error: 'No autorizado' });
    await pool.query('UPDATE users SET organization_id = NULL, role = $1 WHERE id = $2 AND organization_id = $3', ['owner', req.params.id, org.rows[0].id]);
    await pool.query('DELETE FROM machine_shares WHERE user_id = $1', [req.params.id]);
    res.json({ message: 'Miembro removido' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Compartir maquinas con un tecnico
app.post('/api/machines/share', authenticateToken, async (req, res) => {
  try {
    const { user_id, machine_ids } = req.body;
    if (!user_id || !machine_ids) return res.status(400).json({ error: 'user_id y machine_ids requeridos' });

    // Verificar que soy dueño de las maquinas
    const myMachines = await pool.query('SELECT id FROM machines WHERE user_id = $1', [req.user.id]);
    const myIds = new Set(myMachines.rows.map(m => m.id));

    // Borrar shares anteriores de este tecnico con mis maquinas
    await pool.query('DELETE FROM machine_shares WHERE user_id = $1 AND shared_by = $2', [user_id, req.user.id]);

    // Crear nuevos shares
    for (const machineId of machine_ids) {
      if (myIds.has(machineId)) {
        await pool.query(
          'INSERT INTO machine_shares (machine_id, user_id, shared_by) VALUES ($1, $2, $3) ON CONFLICT (machine_id, user_id) DO NOTHING',
          [machineId, user_id, req.user.id]
        );
      }
    }
    res.json({ message: 'Maquinas compartidas', count: machine_ids.length });
  } catch (error) {
    console.error('Error compartiendo:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Obtener maquinas compartidas con un tecnico
app.get('/api/machines/shared/:userId', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT machine_id FROM machine_shares WHERE user_id = $1 AND shared_by = $2',
      [req.params.userId, req.user.id]
    );
    res.json(result.rows.map(r => r.machine_id));
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== PUSH NOTIFICATIONS ==============

// Registrar token FCM del dispositivo
app.post('/api/fcm-token', authenticateToken, async (req, res) => {
  try {
    const { fcm_token } = req.body;
    if (!fcm_token) return res.status(400).json({ error: 'fcm_token requerido' });
    await pool.query('UPDATE users SET fcm_token = $1 WHERE id = $2', [fcm_token, req.user.id]);
    res.json({ message: 'Token FCM registrado' });
  } catch (error) {
    console.error('Error registrando FCM token:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Funcion para enviar push a un usuario
async function sendPush(userId, title, body, data = {}) {
  try {
    const user = await pool.query('SELECT fcm_token, email, email_notifications, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from FROM users WHERE id = $1', [userId]);
    const u = user.rows[0];
    if (!u) return;

    // Push notification
    if (firebaseAdmin && u.fcm_token) {
      try {
        await firebaseAdmin.messaging().send({
          token: u.fcm_token,
          notification: { title, body },
          data: { ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
          android: { priority: 'high', notification: { sound: 'default', channelId: 'servereyes' } }
        });
        console.log(`[PUSH] Enviado a user ${userId}: ${title}`);
      } catch (err) {
        console.error(`[PUSH] Error enviando a user ${userId}:`, err.message);
        if (err.code === 'messaging/registration-token-not-registered') {
          await pool.query('UPDATE users SET fcm_token = NULL WHERE id = $1', [userId]);
        }
      }
    }

    // Email notification (usa SMTP del usuario si tiene, sino el global)
    if (u.email_notifications !== false && u.email) {
      const htmlBody = `<p style="font-size:15px;color:#333;margin:0 0 12px"><strong>${title}</strong></p><p style="color:#666;margin:0">${body}</p>`;
      if (u.smtp_user && u.smtp_pass) {
        sendEmailWithUserSMTP(u, title, htmlBody);
      } else {
        sendEmail(u.email, title, htmlBody);
      }
    }
  } catch (err) {
    console.error(`[NOTIFY] Error para user ${userId}:`, err.message);
  }
}

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

// Speed test pendientes (machine_id -> true)
const pendingSpeedTests = new Set();

// ============== RUTAS PUBLICAS (WINDOWS CLIENT) ==============

// Heartbeat desde el cliente Windows
app.post('/api/heartbeat', async (req, res) => {
  try {
    const { machine_key, machine_name, public_ip, local_ip, os_info, ping_ms, download_mbps, cpu_usage, ram_usage, ram_total, disk_usage, disk_total, disks, agent_version: reportedVersion, agent_logs, agent_type, services, open_ports, agent_config, backup_status } = req.body;

    if (!machine_key) {
      return res.status(400).json({ error: 'machine_key es requerido' });
    }

    // Si solo viene download_mbps (resultado de speed test)
    if (download_mbps !== undefined && !public_ip) {
      await pool.query(
        'UPDATE machines SET download_mbps = $1, speed_test_at = NOW() WHERE machine_key = $2',
        [download_mbps, machine_key]
      );
      return res.json({ status: 'speed_test_saved' });
    }

    // Obtener IP actual antes del update para detectar cambio real
    const beforeUpdate = await pool.query('SELECT public_ip FROM machines WHERE machine_key = $1', [machine_key]);
    const oldPublicIp = beforeUpdate.rows[0]?.public_ip;

    // Actualizar maquina (solo detectar cambio de IP si check_ip_change = true)
    const result = await pool.query(
      `UPDATE machines SET
        previous_public_ip = CASE WHEN check_ip_change = true AND public_ip IS NOT NULL AND public_ip != $1 AND (previous_public_ip IS NULL OR previous_public_ip != $1) THEN public_ip ELSE previous_public_ip END,
        ip_changed_at = CASE WHEN check_ip_change = true AND public_ip IS NOT NULL AND public_ip != $1 AND (previous_public_ip IS NULL OR previous_public_ip != $1) THEN NOW() ELSE ip_changed_at END,
        ip_change_seen = CASE WHEN check_ip_change = true AND public_ip IS NOT NULL AND public_ip != $1 AND (previous_public_ip IS NULL OR previous_public_ip != $1) THEN false ELSE ip_change_seen END,
        public_ip = $1,
        local_ip = $2,
        os_info = $3,
        ping_ms = $4,
        cpu_usage = COALESCE($6, cpu_usage),
        ram_usage = COALESCE($7, ram_usage),
        ram_total = COALESCE($8, ram_total),
        disk_usage = COALESCE($9, disk_usage),
        disk_total = COALESCE($10, disk_total),
        agent_version = COALESCE($11, agent_version),
        disks = COALESCE($12, disks),
        agent_logs = COALESCE($13, agent_logs),
        services = COALESCE($14, services),
        open_ports = COALESCE($15, open_ports),
        agent_config = COALESCE($16, agent_config),
        backup_status = COALESCE($17, backup_status),
        last_heartbeat = NOW(),
        is_online = true,
        offline_notified = false
      WHERE machine_key = $5
      RETURNING *`,
      [public_ip, local_ip, os_info, ping_ms, machine_key, cpu_usage, ram_usage, ram_total, disk_usage, disk_total, reportedVersion, disks ? JSON.stringify(disks) : null, agent_logs || null, services ? JSON.stringify(services) : null, open_ports ? JSON.stringify(open_ports) : null, agent_config ? JSON.stringify(agent_config) : null, backup_status ? JSON.stringify(backup_status) : null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Maquina no registrada. Registrala desde la app movil.' });
    }

    // Log del heartbeat
    const updatedMachine = result.rows[0];
    await pool.query(
      'INSERT INTO heartbeat_log (machine_id, public_ip) VALUES ($1, $2)',
      [updatedMachine.id, public_ip]
    );

    // Geolocalizar IP si no tiene geo o cambio la IP (skip si fue editado manualmente)
    if (public_ip && updatedMachine && !updatedMachine.geo_manual && (!updatedMachine.geo_city || updatedMachine.public_ip !== public_ip)) {
      try {
        const https = require('https');
        https.get('https://ipwho.is/' + public_ip, (geoRes) => {
          let geoData = '';
          geoRes.on('data', c => geoData += c);
          geoRes.on('end', () => {
            try {
              const geo = JSON.parse(geoData);
              if (geo.success) {
                pool.query('UPDATE machines SET geo_city = $1, geo_region = $2, geo_country = $3, geo_lat = $4, geo_lon = $5 WHERE id = $6',
                  [geo.city, geo.region, geo.country, geo.latitude, geo.longitude, updatedMachine.id]);
              }
            } catch {}
          });
        }).on('error', () => {});
      } catch {}
    }

    // Actualizar config_backup_at si se recibio config
    if (agent_config && updatedMachine) {
      pool.query('UPDATE machines SET config_backup_at = NOW() WHERE id = $1', [updatedMachine.id]).catch(() => {});
    }

    // Guardar metricas historicas (si hay datos)
    if (cpu_usage !== undefined || ram_usage !== undefined || ping_ms !== undefined) {
      await pool.query(
        'INSERT INTO metrics_history (machine_id, cpu_usage, ram_usage, ram_total, disks, ping_ms) VALUES ($1, $2, $3, $4, $5, $6)',
        [result.rows[0].id, cpu_usage || null, ram_usage || null, ram_total || null, disks ? JSON.stringify(disks) : null, ping_ms || null]
      );
    }

    // Registrar cambio a online si estaba offline
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

    // Chequear umbrales de alerta (max 1 alerta cada 5 minutos por maquina)
    if (updatedMachine && updatedMachine.user_id) {
      const alertCooldown = updatedMachine.last_alert_at ? (Date.now() - new Date(updatedMachine.last_alert_at).getTime()) > 300000 : true;
      if (alertCooldown) {
        const alerts = [];
        if (updatedMachine.alert_cpu && cpu_usage !== undefined && cpu_usage >= updatedMachine.alert_cpu) {
          alerts.push(`CPU al ${cpu_usage}% (umbral: ${updatedMachine.alert_cpu}%)`);
        }
        if (updatedMachine.alert_ram && ram_usage !== undefined && ram_total) {
          const ramPct = Math.round((ram_usage / ram_total) * 100);
          if (ramPct >= updatedMachine.alert_ram) alerts.push(`RAM al ${ramPct}% (umbral: ${updatedMachine.alert_ram}%)`);
        }
        if (disks && Array.isArray(disks) && disks.length > 0) {
          const perDisk = updatedMachine.alert_disks || {};
          const globalDisk = updatedMachine.alert_disk;
          for (const disk of disks) {
            if (disk.total > 0) {
              const threshold = perDisk[disk.drive] || globalDisk;
              if (threshold) {
                const diskPct = Math.round((disk.used / disk.total) * 100);
                if (diskPct >= threshold) alerts.push(`Disco ${disk.drive} al ${diskPct}% (umbral: ${threshold}%)`);
              }
            }
          }
        } else if (updatedMachine.alert_disk && disk_usage !== undefined && disk_total) {
          const diskPct = Math.round((disk_usage / disk_total) * 100);
          if (diskPct >= updatedMachine.alert_disk) alerts.push(`Disco al ${diskPct}% (umbral: ${updatedMachine.alert_disk}%)`);
        }
        if (updatedMachine.alert_ping && ping_ms && ping_ms >= updatedMachine.alert_ping) {
          alerts.push(`Ping ${ping_ms}ms (umbral: ${updatedMachine.alert_ping}ms)`);
        }
        if (alerts.length > 0) {
          sendPush(updatedMachine.user_id, `⚠️ Alerta: ${updatedMachine.machine_name}`, alerts.join(' | '), { type: 'threshold_alert', machineId: String(updatedMachine.id) });
          await pool.query('UPDATE machines SET last_alert_at = NOW() WHERE id = $1', [updatedMachine.id]);
        }
      }
    }

    // Detectar si la IP realmente cambio en ESTE heartbeat
    const ipActuallyChanged = oldPublicIp && public_ip && oldPublicIp !== public_ip;

    // Registrar cambio de IP en historial (solo cuando realmente cambio)
    if (updatedMachine && ipActuallyChanged) {
      await pool.query(
        'INSERT INTO ip_history (machine_id, public_ip, previous_ip) VALUES ($1, $2, $3)',
        [updatedMachine.id, public_ip, oldPublicIp]
      );
    }

    // Push notification si cambio la IP (solo si check_ip_change esta activo)
    if (updatedMachine && updatedMachine.check_ip_change && ipActuallyChanged && updatedMachine.user_id) {
      sendPush(updatedMachine.user_id, '🌐 IP cambio', `${updatedMachine.machine_name}: ${oldPublicIp} → ${public_ip}`, { type: 'ip_change', machineId: String(updatedMachine.id) });
    }

    // Auto-update DNS si cambio la IP y tiene URL configurada (solo si check_ip_change esta activo)
    if (updatedMachine && updatedMachine.check_ip_change && updatedMachine.dns_update_url && ipActuallyChanged) {
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
        }).on('error', (e) => { console.error('[DNS] Auto-update error:', e.message); });
      } catch (e) { console.error('[DNS] Auto-update error:', e.message); }
    }

    // Chequear si hay speed test pendiente
    const runSpeedtest = pendingSpeedTests.has(updatedMachine.id);
    if (runSpeedtest) pendingSpeedTests.delete(updatedMachine.id);

    // Comparar versiones semver (retorna true si b es mayor que a)
    function isNewerVersion(current, latest) {
      if (!current || !latest) return false;
      const a = current.split('.').map(Number);
      const b = latest.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((b[i] || 0) > (a[i] || 0)) return true;
        if ((b[i] || 0) < (a[i] || 0)) return false;
      }
      return false; // iguales
    }

    // Chequear si hay update disponible (solo si la version del server es MAYOR)
    let updateInfo = null;
    try {
      const type = agent_type || 'agent';
      const verKey = type === 'client' ? 'client_version' : 'agent_version';
      const urlKey = type === 'client' ? 'client_url' : 'agent_url';
      const verRow = await pool.query("SELECT value FROM app_settings WHERE key = $1", [verKey]);
      const urlRow = await pool.query("SELECT value FROM app_settings WHERE key = $1", [urlKey]);
      if (verRow.rows.length > 0 && urlRow.rows.length > 0) {
        const latestVersion = verRow.rows[0].value;
        const updateUrl = urlRow.rows[0].value;
        if (latestVersion && updateUrl && reportedVersion && isNewerVersion(reportedVersion, latestVersion)) {
          updateInfo = { version: latestVersion, url: updateUrl };
        }
      }
      // Fallback: si no hay version especifica para client, probar con agent
      if (!updateInfo && type === 'client') {
        const verRow2 = await pool.query("SELECT value FROM app_settings WHERE key = 'agent_version'");
        const urlRow2 = await pool.query("SELECT value FROM app_settings WHERE key = 'agent_url'");
        if (verRow2.rows.length > 0 && urlRow2.rows.length > 0 && verRow2.rows[0].value && urlRow2.rows[0].value && reportedVersion && isNewerVersion(reportedVersion, verRow2.rows[0].value)) {
          updateInfo = { version: verRow2.rows[0].value, url: urlRow2.rows[0].value };
        }
      }
    } catch {}

    // Comandos remotos pendientes
    let pendingCommands = [];
    try {
      const cmds = await pool.query(
        "SELECT id, command FROM remote_commands WHERE machine_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 5",
        [updatedMachine.id]
      );
      pendingCommands = cmds.rows;
    } catch {}

    // Check backup pendiente
    const checkBackup = updatedMachine.check_backup_pending || false;
    if (checkBackup) {
      pool.query('UPDATE machines SET check_backup_pending = false WHERE id = $1', [updatedMachine.id]).catch(() => {});
    }

    // Alerta de backup fallido (1 sola vez)
    if (backup_status && backup_status.status === 'error' && !updatedMachine.backup_alert_sent && updatedMachine.user_id) {
      sendPush(updatedMachine.user_id, '🚨 Backup FALLO', `${updatedMachine.machine_name}: ${backup_status.message || 'Error en el backup'}`, { type: 'backup_error', machineId: String(updatedMachine.id) });
      pool.query('UPDATE machines SET backup_alert_sent = true WHERE id = $1', [updatedMachine.id]).catch(() => {});
    }
    // Resetear alerta cuando el backup vuelve a estar ok
    if (backup_status && (backup_status.status === 'ok' || backup_status.status === 'found') && updatedMachine.backup_alert_sent) {
      pool.query('UPDATE machines SET backup_alert_sent = false WHERE id = $1', [updatedMachine.id]).catch(() => {});
    }

    res.json({ status: 'ok', machine: result.rows[0], run_speedtest: runSpeedtest, update: updateInfo, commands: pendingCommands, check_backup: checkBackup });
  } catch (error) {
    console.error('Error en heartbeat:', error.message, error.stack);
    res.status(500).json({ error: 'Error interno', detail: error.message });
  }
});

// ============== RUTAS PROTEGIDAS (APP MOVIL) ==============

// Obtener todas las maquinas del usuario (propias + compartidas)
app.get('/api/machines', authenticateToken, async (req, res) => {
  try {
    // Maquinas propias
    const own = await pool.query(
      'SELECT *, false as is_shared FROM machines WHERE user_id = $1 ORDER BY grupo NULLS LAST, orden, machine_name',
      [req.user.id]
    );
    // Maquinas compartidas conmigo
    const shared = await pool.query(
      `SELECT m.*, true as is_shared, u.email as owner_email, u.nombre as owner_name
       FROM machines m
       JOIN machine_shares ms ON ms.machine_id = m.id
       LEFT JOIN users u ON m.user_id = u.id
       WHERE ms.user_id = $1
       ORDER BY m.grupo NULLS LAST, m.machine_name`,
      [req.user.id]
    );
    res.json([...own.rows, ...shared.rows]);
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
    const { machine_name, grupo, orden, dns_update_url, dns_host, check_ip_change, notes, alert_cpu, alert_ram, alert_disk, alert_ping, alert_offline, monitored_disks } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;

    if (machine_name !== undefined) { fields.push(`machine_name = $${idx++}`); values.push(machine_name); }
    if (grupo !== undefined) { fields.push(`grupo = $${idx++}`); values.push(grupo || null); }
    if (orden !== undefined) { fields.push(`orden = $${idx++}`); values.push(orden); }
    if (dns_update_url !== undefined) { fields.push(`dns_update_url = $${idx++}`); values.push(dns_update_url || null); }
    if (dns_host !== undefined) { fields.push(`dns_host = $${idx++}`); values.push(dns_host || null); }
    if (check_ip_change !== undefined) { fields.push(`check_ip_change = $${idx++}`); values.push(check_ip_change); }
    if (notes !== undefined) { fields.push(`notes = $${idx++}`); values.push(notes); }
    if (alert_cpu !== undefined) { fields.push(`alert_cpu = $${idx++}`); values.push(alert_cpu); }
    if (alert_ram !== undefined) { fields.push(`alert_ram = $${idx++}`); values.push(alert_ram); }
    if (alert_disk !== undefined) { fields.push(`alert_disk = $${idx++}`); values.push(alert_disk); }
    if (alert_ping !== undefined) { fields.push(`alert_ping = $${idx++}`); values.push(alert_ping); }
    if (alert_offline !== undefined) { fields.push(`alert_offline = $${idx++}`); values.push(alert_offline); }
    if (monitored_disks !== undefined) { fields.push(`monitored_disks = $${idx++}`); values.push(JSON.stringify(monitored_disks)); }
    if (req.body.alert_disks !== undefined) { fields.push(`alert_disks = $${idx++}`); values.push(JSON.stringify(req.body.alert_disks)); }
    if (req.body.rdp_port !== undefined) { fields.push(`rdp_port = $${idx++}`); values.push(req.body.rdp_port); }
    if (req.body.rdp_user !== undefined) { fields.push(`rdp_user = $${idx++}`); values.push(req.body.rdp_user || null); }
    if (req.body.mac_address !== undefined) { fields.push(`mac_address = $${idx++}`); values.push(req.body.mac_address || null); }
    if (req.body.wol_broadcast !== undefined) { fields.push(`wol_broadcast = $${idx++}`); values.push(req.body.wol_broadcast || '255.255.255.255'); }
    if (req.body.geo_city !== undefined) { fields.push(`geo_city = $${idx++}`); values.push(req.body.geo_city || null); fields.push(`geo_manual = true`); }
    if (req.body.geo_region !== undefined) { fields.push(`geo_region = $${idx++}`); values.push(req.body.geo_region || null); }
    if (req.body.geo_country !== undefined) { fields.push(`geo_country = $${idx++}`); values.push(req.body.geo_country || null); }
    if (req.body.geo_lat !== undefined) { fields.push(`geo_lat = $${idx++}`); values.push(req.body.geo_lat); }
    if (req.body.geo_lon !== undefined) { fields.push(`geo_lon = $${idx++}`); values.push(req.body.geo_lon); }

    if (fields.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

    values.push(req.params.id, req.user.id);
    const result = await pool.query(
      `UPDATE machines SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    logAudit(req.user.id, 'edit_machine', 'machine', parseInt(req.params.id), JSON.stringify(req.body), req.ip);
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

// Solicitar speed test a una maquina
app.post('/api/machines/:id/speedtest', authenticateToken, async (req, res) => {
  try {
    const machine = await pool.query('SELECT id FROM machines WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    pendingSpeedTests.add(machine.rows[0].id);
    res.json({ message: 'Speed test solicitado. Se ejecutara en el proximo heartbeat.' });
  } catch (error) {
    console.error('Error solicitando speed test:', error);
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
    const delResult = await pool.query(
      'DELETE FROM machines WHERE id = $1 AND user_id = $2 RETURNING machine_name',
      [req.params.id, req.user.id]
    );
    if (delResult.rows.length > 0) logAudit(req.user.id, 'delete_machine', 'machine', parseInt(req.params.id), delResult.rows[0].machine_name, req.ip);
    res.json({ message: 'Maquina eliminada' });
  } catch (error) {
    console.error('Error al eliminar maquina:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Obtener historial de IPs de una maquina
app.get('/api/machines/:id/ip-history', authenticateToken, async (req, res) => {
  try {
    const machine = await pool.query('SELECT id FROM machines WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });

    const result = await pool.query(
      `SELECT public_ip, previous_ip, changed_at FROM ip_history
       WHERE machine_id = $1 ORDER BY changed_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error en ip-history:', error);
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
        if (machine.alert_offline !== false) {
          const inMaint = await isInMaintenance(machine.id, machine.user_id);
          if (!inMaint) {
            sendPush(machine.user_id, '⚠️ Maquina OFFLINE', `${machine.machine_name} dejo de responder`, { type: 'offline', machineId: String(machine.id) });
          } else {
            console.log(`[MAINT] Alerta suprimida para ${machine.machine_name} (en ventana de mantenimiento)`);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error en detector offline:', error);
  }
}, 30000);

// ============== ADMIN ==============

// Middleware admin
async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  const user = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
  if (!user.rows[0]?.is_admin) return res.status(403).json({ error: 'No autorizado' });
  next();
}

// Dashboard admin: todos los usuarios y maquinas
app.get('/api/admin/overview', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await pool.query('SELECT id, email, nombre, is_admin, created_at, fcm_token IS NOT NULL as has_push FROM users ORDER BY id');
    const machines = await pool.query(`SELECT m.*, u.email as owner_email FROM machines m LEFT JOIN users u ON m.user_id = u.id ORDER BY m.id`);
    const totalUsers = users.rows.length;
    const totalMachines = machines.rows.length;
    const onlineMachines = machines.rows.filter(m => m.is_online).length;
    const agentFile = await pool.query('SELECT id, version, filename, file_size, changelog, uploaded_at FROM agent_files ORDER BY uploaded_at DESC LIMIT 1');
    const ver = await pool.query("SELECT value FROM app_settings WHERE key = 'agent_version'");
    res.json({
      stats: { totalUsers, totalMachines, onlineMachines, offlineMachines: totalMachines - onlineMachines },
      users: users.rows,
      machines: machines.rows,
      latestAgent: agentFile.rows[0] || null,
      configuredVersion: ver.rows[0]?.value || null
    });
  } catch (error) {
    console.error('Error en admin overview:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Subir nuevo agente (base64)
app.post('/api/admin/agent/upload', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { version, filename, file_base64, changelog } = req.body;
    if (!version || !file_base64) return res.status(400).json({ error: 'version y file_base64 requeridos' });
    const buffer = Buffer.from(file_base64, 'base64');
    if (buffer.length < 1024 * 100) return res.status(400).json({ error: 'Archivo muy chico, parece invalido' });

    await pool.query(
      'INSERT INTO agent_files (version, filename, file_data, file_size, changelog) VALUES ($1, $2, $3, $4, $5)',
      [version, filename || 'ServerEyes-Agent.exe', buffer, buffer.length, changelog || '']
    );

    // Actualizar version configurada y URL de descarga automaticamente
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
    const downloadUrl = `${protocol}://${req.get('host')}/api/agent/download`;
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('agent_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [version]);
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('agent_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [downloadUrl]);

    res.json({ message: 'Agente subido', version, size: buffer.length, downloadUrl });
  } catch (error) {
    console.error('Error subiendo agente:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Descargar agente (publico, sin auth - los agentes lo descargan)
app.get('/api/agent/download', async (req, res) => {
  try {
    const result = await pool.query('SELECT filename, file_data FROM agent_files ORDER BY uploaded_at DESC LIMIT 1');
    if (result.rows.length === 0) return res.status(404).json({ error: 'No hay agente disponible' });
    const { filename, file_data } = result.rows[0];
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(file_data);
  } catch (error) {
    console.error('Error descargando agente:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Toggle admin de un usuario
app.post('/api/admin/toggle-admin', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { user_id, is_admin } = req.body;
    await pool.query('UPDATE users SET is_admin = $1 WHERE id = $2', [is_admin, user_id]);
    res.json({ message: 'Actualizado' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Resetear contraseña de un usuario
app.post('/api/admin/reset-password', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { user_id, new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Minimo 6 caracteres' });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user_id]);
    res.json({ message: 'Contraseña reseteada' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Historial de metricas de una maquina
app.get('/api/machines/:id/metrics', authenticateToken, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const machine = await pool.query(
      'SELECT id FROM machines WHERE id = $1 AND (user_id = $2 OR EXISTS (SELECT 1 FROM machine_shares ms WHERE ms.machine_id = $1 AND ms.user_id = $2))',
      [req.params.id, req.user.id]
    );
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });

    // Agrupar por intervalos para no devolver miles de puntos
    // < 6h: cada punto, 6-24h: cada 5 min, 24-72h: cada 15 min, >72h: cada hora
    let interval = '1 minute';
    if (hours > 72) interval = '1 hour';
    else if (hours > 24) interval = '15 minutes';
    else if (hours > 6) interval = '5 minutes';

    const result = await pool.query(`
      SELECT
        date_trunc('${interval.split(' ')[1]}', timestamp) as time,
        ROUND(AVG(cpu_usage)::numeric, 1) as cpu,
        ROUND(AVG(ram_usage)::numeric, 1) as ram,
        MAX(ram_total) as ram_total,
        ROUND(AVG(ping_ms)::numeric, 0) as ping,
        (array_agg(disks ORDER BY timestamp DESC))[1] as disks
      FROM metrics_history
      WHERE machine_id = $1 AND timestamp > NOW() - INTERVAL '1 hour' * $2
      GROUP BY date_trunc('${interval.split(' ')[1]}', timestamp)
      ORDER BY time ASC
    `, [req.params.id, hours]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error en metrics:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Limpieza automatica de metricas viejas (>7 dias) cada hora
setInterval(async () => {
  try {
    const result = await pool.query("DELETE FROM metrics_history WHERE timestamp < NOW() - INTERVAL '7 days'");
    if (result.rowCount > 0) console.log(`[CLEANUP] Eliminadas ${result.rowCount} metricas viejas`);
  } catch {}
}, 3600000);

// Generar archivo RDP para conexion remota
app.get('/api/machines/:id/rdp', authenticateToken, async (req, res) => {
  try {
    const machine = await pool.query('SELECT * FROM machines WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    const m = machine.rows[0];
    const ip = m.public_ip || m.local_ip?.split(' ')[0] || '0.0.0.0';
    const port = m.rdp_port || 3389;
    const rdpContent = [
      'full address:s:' + ip + ':' + port,
      'prompt for credentials:i:1',
      'administrative session:i:1',
      m.rdp_user ? 'username:s:' + m.rdp_user : '',
      'screen mode id:i:2',
      'desktopwidth:i:1920',
      'desktopheight:i:1080',
      'session bpp:i:32',
      'compression:i:1',
      'displayconnectionbar:i:1',
      'disable wallpaper:i:0',
      'autoreconnection enabled:i:1',
    ].filter(Boolean).join('\r\n');
    res.set({ 'Content-Type': 'application/x-rdp', 'Content-Disposition': `attachment; filename="${m.machine_name.replace(/[^a-zA-Z0-9]/g, '_')}.rdp"` });
    res.send(rdpContent);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Reporte HTML imprimible (guardar como PDF desde el navegador)
app.get('/api/machines/report/pdf', async (req, res, next) => {
  // Soportar token en query param para abrir en nueva pestaña
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  authenticateToken(req, res, next);
}, async (req, res) => {
  try {
    const machines = await pool.query('SELECT * FROM machines WHERE user_id = $1 ORDER BY grupo NULLS LAST, machine_name', [req.user.id]);
    const online = machines.rows.filter(m => m.is_online).length;
    const offline = machines.rows.length - online;
    const fecha = new Date().toLocaleString('es');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ServerEyes - Reporte</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: Arial, sans-serif; padding: 30px; color: #222; }
      h1 { font-size: 22px; margin-bottom: 4px; }
      .sub { color: #888; font-size: 13px; margin-bottom: 20px; }
      .stats { display: flex; gap: 20px; margin-bottom: 24px; }
      .stat { border: 1px solid #ddd; border-radius: 8px; padding: 12px 20px; text-align: center; }
      .stat .num { font-size: 28px; font-weight: 800; }
      .stat .label { color: #888; font-size: 12px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 20px; }
      th { background: #f5f5f5; text-align: left; padding: 8px; border: 1px solid #ddd; font-weight: 600; }
      td { padding: 6px 8px; border: 1px solid #ddd; }
      tr:nth-child(even) { background: #fafafa; }
      .online { color: #2e7d32; font-weight: 600; }
      .offline { color: #c62828; font-weight: 600; }
      .bar { display: inline-block; height: 10px; border-radius: 3px; }
      @media print { body { padding: 15px; } }
    </style></head><body>
    <h1>ServerEyes - Reporte de Maquinas</h1>
    <p class="sub">Generado: ${fecha} | Total: ${machines.rows.length} | Online: ${online} | Offline: ${offline}</p>
    <div class="stats">
      <div class="stat"><div class="num">${machines.rows.length}</div><div class="label">Total</div></div>
      <div class="stat"><div class="num" style="color:#2e7d32">${online}</div><div class="label">Online</div></div>
      <div class="stat"><div class="num" style="color:#c62828">${offline}</div><div class="label">Offline</div></div>
    </div>
    <table>
      <tr><th>Nombre</th><th>Grupo</th><th>Estado</th><th>IP Publica</th><th>IP Local</th><th>Ping</th><th>CPU</th><th>RAM</th><th>Discos</th><th>OS</th></tr>
      ${machines.rows.map(m => {
        const disksStr = m.disks && Array.isArray(m.disks) ? m.disks.map(d => d.drive + ' ' + d.used + '/' + d.total + 'GB').join(', ') : (m.disk_usage ? 'C: ' + m.disk_usage + '/' + m.disk_total + 'GB' : '');
        const ramPct = m.ram_usage && m.ram_total ? Math.round(m.ram_usage / m.ram_total * 100) + '%' : '';
        return `<tr>
          <td><strong>${m.machine_name}</strong></td>
          <td>${m.grupo || ''}</td>
          <td class="${m.is_online ? 'online' : 'offline'}">${m.is_online ? 'ONLINE' : 'OFFLINE'}</td>
          <td>${m.public_ip || ''}</td>
          <td>${(m.local_ip || '').replace(/ \| /g, '<br>')}</td>
          <td>${m.ping_ms ? m.ping_ms + 'ms' : ''}</td>
          <td>${m.cpu_usage != null ? m.cpu_usage + '%' : ''}</td>
          <td>${m.ram_usage ? m.ram_usage + '/' + m.ram_total + 'GB (' + ramPct + ')' : ''}</td>
          <td style="font-size:11px">${disksStr}</td>
          <td style="font-size:10px">${m.os_info || ''}</td>
        </tr>`;
      }).join('')}
    </table>
    <p style="color:#888;font-size:11px">ServerEyes - ${fecha}</p>
    <script>window.print();</script>
    </body></html>`;

    res.send(html);
  } catch (error) {
    console.error('Error generando reporte:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Resultado de comando remoto (desde el agente, sin auth)
app.post('/api/command-result', async (req, res) => {
  try {
    const { machine_key, command_id, output } = req.body;
    if (!machine_key || !command_id) return res.status(400).json({ error: 'machine_key y command_id requeridos' });
    const machine = await pool.query('SELECT id FROM machines WHERE machine_key = $1', [machine_key]);
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    await pool.query(
      "UPDATE remote_commands SET status = 'completed', output = $1, executed_at = NOW() WHERE id = $2 AND machine_id = $3",
      [(output || '').substring(0, 10000), command_id, machine.rows[0].id]
    );
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== COMANDOS REMOTOS ==============

// Enviar comando a una maquina
app.post('/api/machines/:id/command', authenticateToken, async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'command requerido' });
    const machine = await pool.query('SELECT id FROM machines WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    const result = await pool.query(
      'INSERT INTO remote_commands (machine_id, user_id, command) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, req.user.id, command]
    );
    logAudit(req.user.id, 'remote_command', 'machine', parseInt(req.params.id), command, req.ip);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error enviando comando:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Listar comandos de una maquina
app.get('/api/machines/:id/commands', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rc.* FROM remote_commands rc JOIN machines m ON rc.machine_id = m.id
       WHERE m.id = $1 AND (m.user_id = $2 OR EXISTS (SELECT 1 FROM machine_shares ms WHERE ms.machine_id = m.id AND ms.user_id = $2))
       ORDER BY rc.created_at DESC LIMIT 20`,
      [req.params.id, req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Solicitar chequeo de backup a una maquina
app.post('/api/machines/:id/check-backup', authenticateToken, async (req, res) => {
  try {
    const machine = await pool.query('SELECT id FROM machines WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    await pool.query('UPDATE machines SET check_backup_pending = true WHERE id = $1', [req.params.id]);
    res.json({ message: 'Chequeo de backup solicitado. Resultado en el proximo heartbeat.' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Backup status de una maquina
app.get('/api/machines/:id/backup', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT backup_status FROM machines WHERE id = $1 AND (user_id = $2 OR EXISTS (SELECT 1 FROM machine_shares ms WHERE ms.machine_id = $1 AND ms.user_id = $2))',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    res.json(result.rows[0].backup_status || { status: 'unknown', message: 'Sin datos. Actualiza el agente.' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Config backup de una maquina
app.get('/api/machines/:id/config', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT agent_config, config_backup_at FROM machines WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    res.json({ config: result.rows[0].agent_config, backed_up_at: result.rows[0].config_backup_at });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Servicios y puertos de una maquina
app.get('/api/machines/:id/services', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT m.services, m.open_ports FROM machines m WHERE m.id = $1 AND (m.user_id = $2 OR EXISTS (SELECT 1 FROM machine_shares ms WHERE ms.machine_id = m.id AND ms.user_id = $2))',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    res.json({ services: result.rows[0].services || [], open_ports: result.rows[0].open_ports || [] });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Historial global de comandos remotos (todos los del usuario)
app.get('/api/commands/history', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rc.*, m.machine_name FROM remote_commands rc
       JOIN machines m ON rc.machine_id = m.id
       WHERE m.user_id = $1
       ORDER BY rc.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Exportar maquinas como CSV
app.get('/api/machines/export/csv', authenticateToken, async (req, res) => {
  try {
    const own = await pool.query('SELECT * FROM machines WHERE user_id = $1 ORDER BY grupo NULLS LAST, machine_name', [req.user.id]);
    const machines = own.rows;

    const headers = ['Nombre', 'Grupo', 'Estado', 'IP Publica', 'IP Local', 'Ping (ms)', 'CPU %', 'RAM Usada (GB)', 'RAM Total (GB)', 'Discos', 'OS', 'Version Agente', 'Ultimo Heartbeat', 'Notas'];
    const rows = machines.map(m => {
      const disksStr = m.disks && Array.isArray(m.disks) ? m.disks.map(d => `${d.drive} ${d.used}/${d.total}GB`).join(' | ') : `${m.disk_usage || ''}/${m.disk_total || ''}GB`;
      return [
        m.machine_name,
        m.grupo || '',
        m.is_online ? 'Online' : 'Offline',
        m.public_ip || '',
        m.local_ip || '',
        m.ping_ms || '',
        m.cpu_usage != null ? m.cpu_usage : '',
        m.ram_usage != null ? m.ram_usage : '',
        m.ram_total != null ? m.ram_total : '',
        disksStr,
        m.os_info || '',
        m.agent_version || '',
        m.last_heartbeat ? new Date(m.last_heartbeat).toLocaleString() : '',
        (m.notes || '').replace(/"/g, '""')
      ].map(v => `"${v}"`).join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const fecha = new Date().toISOString().split('T')[0];
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="servereyes-${fecha}.csv"`
    });
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8
  } catch (error) {
    console.error('Error exportando CSV:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Obtener logs de un agente
app.get('/api/machines/:id/logs', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT m.agent_logs FROM machines m WHERE m.id = $1 AND (m.user_id = $2 OR EXISTS (SELECT 1 FROM machine_shares ms WHERE ms.machine_id = m.id AND ms.user_id = $2))',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    res.json({ logs: result.rows[0].agent_logs || 'Sin logs disponibles' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Historial de versiones del agente
app.get('/api/admin/agent/history', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, version, filename, file_size, changelog, uploaded_at FROM agent_files ORDER BY uploaded_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== GESTION DE AGENTE ==============

// Obtener version del agente
app.get('/api/agent/version', authenticateToken, async (req, res) => {
  try {
    const ver = await pool.query("SELECT value FROM app_settings WHERE key = 'agent_version'");
    const url = await pool.query("SELECT value FROM app_settings WHERE key = 'agent_url'");
    res.json({
      version: ver.rows[0]?.value || null,
      url: url.rows[0]?.value || null
    });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Configurar version del agente
app.post('/api/agent/version', authenticateToken, async (req, res) => {
  try {
    const { version, url } = req.body;
    if (!version || !url) return res.status(400).json({ error: 'version y url requeridos' });
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('agent_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [version]);
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('agent_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [url]);
    res.json({ message: 'Version actualizada', version, url });
  } catch (error) {
    console.error('Error actualizando version agente:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== RUTA DE ESTADO ==============

// Toggle email notifications
app.post('/api/auth/email-notifications', authenticateToken, async (req, res) => {
  try {
    const { enabled } = req.body;
    await pool.query('UPDATE users SET email_notifications = $1 WHERE id = $2', [enabled !== false, req.user.id]);
    res.json({ message: enabled !== false ? 'Email activado' : 'Email desactivado' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Obtener config SMTP del usuario
app.get('/api/auth/smtp', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query('SELECT smtp_host, smtp_port, smtp_secure, smtp_user, smtp_from, email_notifications FROM users WHERE id = $1', [req.user.id]);
    const u = user.rows[0] || {};
    res.json({ smtp_host: u.smtp_host || '', smtp_port: u.smtp_port || 587, smtp_secure: u.smtp_secure || false, smtp_user: u.smtp_user || '', smtp_from: u.smtp_from || '', email_notifications: u.email_notifications !== false, configured: !!u.smtp_user });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Guardar config SMTP del usuario
app.post('/api/auth/smtp', authenticateToken, async (req, res) => {
  try {
    const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from, email_notifications } = req.body;
    await pool.query(
      'UPDATE users SET smtp_host = $1, smtp_port = $2, smtp_secure = $3, smtp_user = $4, smtp_from = $6, email_notifications = $7 WHERE id = $8',
      [smtp_host || null, smtp_port || 587, smtp_secure || false, smtp_user || null, smtp_from || null, email_notifications !== false, req.user.id]
    );
    // Solo actualizar password si se envió (no vacío)
    if (smtp_pass) {
      await pool.query('UPDATE users SET smtp_pass = $1 WHERE id = $2', [smtp_pass, req.user.id]);
    }
    res.json({ message: 'Configuracion SMTP guardada' });
  } catch (error) {
    console.error('Error guardando SMTP:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Testear SMTP del usuario
app.post('/api/auth/smtp/test', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query('SELECT email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from FROM users WHERE id = $1', [req.user.id]);
    const u = user.rows[0];
    if (!u.smtp_user || !u.smtp_pass) return res.status(400).json({ error: 'Configura tu SMTP primero' });
    await sendEmailWithUserSMTP(u, 'Test', '<p style="color:#333">Email de prueba. Tu configuracion SMTP funciona correctamente!</p>');
    res.json({ message: 'Email de prueba enviado a ' + u.email });
  } catch (error) {
    res.status(500).json({ error: 'Error: ' + error.message });
  }
});

// Test email (admin only)
app.post('/api/admin/test-email', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!emailTransporter) return res.status(400).json({ error: 'Email no configurado. Agrega SMTP_USER y SMTP_PASS en Railway.' });
    const user = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    await sendEmail(user.rows[0].email, 'Test', '<p style="color:#333">Email de prueba desde ServerEyes. Funciona correctamente!</p>');
    res.json({ message: 'Email enviado a ' + user.rows[0].email });
  } catch (error) {
    res.status(500).json({ error: 'Error: ' + error.message });
  }
});

// Test push notification (admin only)
app.post('/api/admin/test-push', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!firebaseAdmin) return res.status(400).json({ error: 'Firebase no esta configurado en el servidor', hint: 'Configura la variable FIREBASE_SERVICE_ACCOUNT en Railway' });
    const user = await pool.query('SELECT fcm_token FROM users WHERE id = $1', [req.user.id]);
    const fcmToken = user.rows[0]?.fcm_token;
    if (!fcmToken) return res.status(400).json({ error: 'No tenes token FCM registrado. Abri la app en el celular primero.' });

    await firebaseAdmin.messaging().send({
      token: fcmToken,
      notification: { title: 'Test ServerEyes', body: 'Push notification funcionando correctamente!' },
      android: { priority: 'high', notification: { sound: 'default', channelId: 'servereyes' } }
    });
    res.json({ message: 'Push enviado exitosamente' });
  } catch (error) {
    console.error('Error test push:', error);
    res.status(500).json({ error: 'Error enviando push: ' + error.message });
  }
});

// ── ADMIN BROADCAST NOTIFICATIONS ──
app.post('/api/admin/broadcast', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Titulo y mensaje requeridos' });

    const notif = await pool.query(
      'INSERT INTO admin_notifications (title, message, sender_id) VALUES ($1, $2, $3) RETURNING id, created_at',
      [title, message, req.user.id]
    );

    // Send push to all users with FCM tokens
    let pushSent = 0, pushFailed = 0;
    if (firebaseAdmin) {
      const users = await pool.query('SELECT id, fcm_token FROM users WHERE fcm_token IS NOT NULL');
      for (const u of users.rows) {
        try {
          await firebaseAdmin.messaging().send({
            token: u.fcm_token,
            notification: { title, body: message },
            android: { priority: 'high', notification: { sound: 'default', channelId: 'servereyes' } }
          });
          pushSent++;
        } catch (e) {
          pushFailed++;
          if (e.code === 'messaging/registration-token-not-registered') {
            await pool.query('UPDATE users SET fcm_token = NULL WHERE id = $1', [u.id]);
          }
        }
      }
    }

    res.json({ message: 'Notificacion enviada', id: notif.rows[0].id, pushSent, pushFailed });
  } catch (error) {
    console.error('Error broadcast:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/admin/notifications', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT n.*, u.email as sender_email,
       (SELECT COUNT(*) FROM notification_reads nr WHERE nr.notification_id = n.id) as read_count
       FROM admin_notifications n LEFT JOIN users u ON n.sender_id = u.id
       ORDER BY n.created_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.delete('/api/admin/notifications/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM admin_notifications WHERE id = $1', [req.params.id]);
    res.json({ message: 'Eliminada' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// User notifications
app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT n.id, n.title, n.message, n.created_at,
       EXISTS(SELECT 1 FROM notification_reads nr WHERE nr.notification_id = n.id AND nr.user_id = $1) as is_read
       FROM admin_notifications n
       WHERE n.created_at > NOW() - INTERVAL '30 days'
       ORDER BY n.created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO notification_reads (notification_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ServerEyes running',
    timestamp: new Date().toISOString(),
    firebase: firebaseAdmin ? 'active' : 'disabled',
    email: emailTransporter ? 'active' : 'disabled',
    version: '1.0.0'
  });
});

// Historial de uptime de una maquina (ultimos N dias)
app.get('/api/machines/:id/uptime', authenticateToken, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
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
    const dailyUptime = {};
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const key = date.toISOString().split('T')[0];
      dailyUptime[key] = { date: key, online_minutes: 0, offline_minutes: 0, total_minutes: 1440, percentage: 0 };
    }

    // Determinar estado inicial antes del periodo consultado
    const priorEvent = await pool.query(
      `SELECT status FROM uptime_log WHERE machine_id = $1 AND timestamp <= NOW() - INTERVAL '1 day' * $2 ORDER BY timestamp DESC LIMIT 1`,
      [req.params.id, days]
    );
    let lastStatus = priorEvent.rows.length > 0 ? priorEvent.rows[0].status : 'offline';
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
    const result = Object.values(dailyUptime).map((d) => {
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

// Historial de caidas (outages)
app.get('/api/machines/:id/outages', authenticateToken, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const machine = await pool.query('SELECT id FROM machines WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    const events = await pool.query(
      `SELECT status, timestamp FROM uptime_log
       WHERE machine_id = $1 AND timestamp > NOW() - INTERVAL '1 day' * $2
       ORDER BY timestamp ASC`,
      [req.params.id, days]
    );
    const outages = [];
    let offlineStart = null;
    for (const e of events.rows) {
      if (e.status === 'offline') {
        offlineStart = e.timestamp;
      } else if (e.status === 'online' && offlineStart) {
        const dur = Math.round((new Date(e.timestamp).getTime() - new Date(offlineStart).getTime()) / 60000);
        outages.push({ start: offlineStart, end: e.timestamp, duration_min: dur });
        offlineStart = null;
      }
    }
    if (offlineStart) {
      const dur = Math.round((Date.now() - new Date(offlineStart).getTime()) / 60000);
      outages.push({ start: offlineStart, end: null, duration_min: dur, ongoing: true });
    }
    res.json({ outages: outages.reverse(), total: outages.length, days });
  } catch (error) {
    console.error('Error en outages:', error);
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

// ============== AUDIT LOG ==============

app.get('/api/audit', authenticateToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await pool.query(
      `SELECT a.*, u.email as user_email FROM audit_log a
       LEFT JOIN users u ON a.user_id = u.id
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC LIMIT $2`,
      [req.user.id, limit]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== MAINTENANCE WINDOWS ==============

app.get('/api/maintenance', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mw.*, m.machine_name FROM maintenance_windows mw
       LEFT JOIN machines m ON mw.machine_id = m.id
       WHERE mw.user_id = $1
       ORDER BY mw.start_time DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/maintenance', authenticateToken, async (req, res) => {
  try {
    const { machine_id, title, start_time, end_time, repeat } = req.body;
    if (!start_time || !end_time) return res.status(400).json({ error: 'start_time y end_time requeridos' });
    const result = await pool.query(
      'INSERT INTO maintenance_windows (user_id, machine_id, title, start_time, end_time, repeat) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.user.id, machine_id || null, title || 'Mantenimiento', start_time, end_time, repeat || 'none']
    );
    logAudit(req.user.id, 'create_maintenance', 'maintenance', result.rows[0].id, title, req.ip);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.delete('/api/maintenance/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM maintenance_windows WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Ventana eliminada' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

function isInMaintenance(machineId, userId) {
  return pool.query(
    `SELECT id FROM maintenance_windows
     WHERE user_id = $1 AND suppress_alerts = true
     AND (machine_id = $2 OR machine_id IS NULL)
     AND NOW() BETWEEN start_time AND end_time
     LIMIT 1`,
    [userId, machineId]
  ).then(r => r.rows.length > 0).catch(() => false);
}

// ============== URL/HTTP MONITORING ==============

app.get('/api/url-monitors', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM url_monitors WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/url-monitors', authenticateToken, async (req, res) => {
  try {
    const { url, name, method, expected_status, timeout_ms, interval_seconds } = req.body;
    if (!url) return res.status(400).json({ error: 'url requerido' });
    const result = await pool.query(
      'INSERT INTO url_monitors (user_id, url, name, method, expected_status, timeout_ms, interval_seconds) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [req.user.id, url, name || url, method || 'GET', expected_status || 200, timeout_ms || 10000, interval_seconds || 300]
    );
    logAudit(req.user.id, 'create_url_monitor', 'url_monitor', result.rows[0].id, url, req.ip);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.put('/api/url-monitors/:id', authenticateToken, async (req, res) => {
  try {
    const { url, name, method, expected_status, timeout_ms, interval_seconds, is_active } = req.body;
    const result = await pool.query(
      `UPDATE url_monitors SET url=COALESCE($1,url), name=COALESCE($2,name), method=COALESCE($3,method),
       expected_status=COALESCE($4,expected_status), timeout_ms=COALESCE($5,timeout_ms),
       interval_seconds=COALESCE($6,interval_seconds), is_active=COALESCE($7,is_active)
       WHERE id=$8 AND user_id=$9 RETURNING *`,
      [url, name, method, expected_status, timeout_ms, interval_seconds, is_active, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Monitor no encontrado' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.delete('/api/url-monitors/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM url_monitors WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Monitor eliminado' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// URL monitor checker (runs every 60 seconds)
function followRedirects(urlStr, method, timeoutMs, maxRedirects) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve, reject) => {
    let redirects = 0;
    function doRequest(url) {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;
      const opts = {
        method: method || 'GET',
        timeout: timeoutMs || 10000,
        headers: { 'User-Agent': 'ServerEyes/1.0 (URL Monitor)' },
        rejectAuthorized: false
      };
      const timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs || 10000);
      const r = client.request(urlObj, opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < (maxRedirects || 5)) {
          redirects++;
          let next = res.headers.location;
          if (next.startsWith('/')) next = urlObj.protocol + '//' + urlObj.host + next;
          res.resume();
          doRequest(next);
          return;
        }
        clearTimeout(timer);
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, redirects }));
      });
      r.on('error', (e) => { clearTimeout(timer); reject(e); });
      r.end();
    }
    doRequest(urlStr);
  });
}
setInterval(async () => {
  try {
    const monitors = await pool.query(
      `SELECT um.*, u.id as owner_id FROM url_monitors um
       JOIN users u ON um.user_id = u.id
       WHERE um.is_active = true
       AND (um.last_check IS NULL OR um.last_check < NOW() - (um.interval_seconds || ' seconds')::INTERVAL)`
    );
    for (const mon of monitors.rows) {
      const startTime = Date.now();
      try {
        const result = await followRedirects(mon.url, mon.method, mon.timeout_ms || 10000, 5);
        const expectedStatus = mon.expected_status || 200;
        const isUp = result.status >= 200 && result.status < 400;
        const wasDown = !mon.is_up;
        await pool.query(
          `UPDATE url_monitors SET last_status=$1, last_response_ms=$2, last_check=NOW(), last_error=NULL,
           is_up=$3, down_since=CASE WHEN $3=true THEN NULL ELSE COALESCE(down_since, NOW()) END
           WHERE id=$4`,
          [result.status, Date.now() - startTime, isUp, mon.id]
        );
        if (wasDown && isUp && mon.notify_down) {
          sendPush(mon.owner_id, '✅ URL Recuperada', `${mon.name || mon.url} esta respondiendo (${Date.now() - startTime}ms)`, { type: 'url_up' });
        } else if (!isUp && mon.is_up && mon.notify_down) {
          sendPush(mon.owner_id, '🚨 URL Caida', `${mon.name || mon.url} respondio ${result.status}`, { type: 'url_down' });
        }
      } catch (err) {
        const wasUp = mon.is_up;
        await pool.query(
          `UPDATE url_monitors SET last_check=NOW(), last_error=$1, last_response_ms=$2,
           is_up=false, down_since=COALESCE(down_since, NOW()) WHERE id=$3`,
          [err.message, Date.now() - startTime, mon.id]
        );
        if (wasUp && mon.notify_down) {
          sendPush(mon.owner_id, '🚨 URL Caida', `${mon.name || mon.url}: ${err.message}`, { type: 'url_down' });
        }
      }
    }
  } catch (err) {
    console.error('[URL-MONITOR] Error:', err.message);
  }
}, 60000);

// ============== WEEKLY REPORT ==============

async function generateWeeklyReport(userId) {
  try {
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user.rows[0] || user.rows[0].email_notifications === false) return;
    const u = user.rows[0];

    const machines_result = await pool.query('SELECT * FROM machines WHERE user_id = $1 ORDER BY machine_name', [userId]);
    const allMachines = machines_result.rows;
    if (allMachines.length === 0) return;

    const online = allMachines.filter(m => m.is_online).length;
    const offline = allMachines.length - online;

    const uptimeData = await pool.query(
      `SELECT machine_id, COUNT(*) FILTER (WHERE status='online') as online_events,
       COUNT(*) FILTER (WHERE status='offline') as offline_events
       FROM uptime_log WHERE timestamp > NOW() - INTERVAL '7 days'
       AND machine_id IN (SELECT id FROM machines WHERE user_id = $1) GROUP BY machine_id`, [userId]
    );

    const alertCount = await pool.query(
      `SELECT COUNT(*) FROM audit_log WHERE user_id = $1 AND action LIKE '%alert%' AND created_at > NOW() - INTERVAL '7 days'`, [userId]
    );

    const urlMonitors = await pool.query('SELECT * FROM url_monitors WHERE user_id = $1', [userId]);

    const machineRows = allMachines.map(m => {
      const cpu = m.cpu_usage != null ? m.cpu_usage + '%' : '—';
      const ram = m.ram_usage && m.ram_total ? Math.round(m.ram_usage / m.ram_total * 100) + '%' : '—';
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee">${m.machine_name}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;color:${m.is_online ? '#4CAF50' : '#F44336'}">${m.is_online ? 'Online' : 'Offline'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee">${cpu}</td>
        <td style="padding:8px;border-bottom:1px solid #eee">${ram}</td>
        <td style="padding:8px;border-bottom:1px solid #eee">${m.ping_ms ? m.ping_ms + 'ms' : '—'}</td>
      </tr>`;
    }).join('');

    const urlRows = urlMonitors.rows.map(u => `<tr>
      <td style="padding:6px;border-bottom:1px solid #eee;font-size:13px">${u.name || u.url}</td>
      <td style="padding:6px;border-bottom:1px solid #eee;color:${u.is_up ? '#4CAF50' : '#F44336'}">${u.is_up ? 'UP' : 'DOWN'}</td>
      <td style="padding:6px;border-bottom:1px solid #eee">${u.last_response_ms ? u.last_response_ms + 'ms' : '—'}</td>
    </tr>`).join('');

    const body = `
      <h3 style="color:#333;margin:0 0 16px">Reporte Semanal</h3>
      <div style="display:flex;gap:16px;margin-bottom:16px">
        <div style="background:#E8F5E9;padding:12px 20px;border-radius:8px;text-align:center;flex:1"><div style="font-size:24px;font-weight:800;color:#4CAF50">${online}</div><div style="font-size:11px;color:#666">Online</div></div>
        <div style="background:#FFEBEE;padding:12px 20px;border-radius:8px;text-align:center;flex:1"><div style="font-size:24px;font-weight:800;color:#F44336">${offline}</div><div style="font-size:11px;color:#666">Offline</div></div>
        <div style="background:#E3F2FD;padding:12px 20px;border-radius:8px;text-align:center;flex:1"><div style="font-size:24px;font-weight:800;color:#2196F3">${allMachines.length}</div><div style="font-size:11px;color:#666">Total</div></div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
        <tr style="background:#f5f5f5"><th style="padding:8px;text-align:left">Maquina</th><th style="padding:8px">Estado</th><th style="padding:8px">CPU</th><th style="padding:8px">RAM</th><th style="padding:8px">Ping</th></tr>
        ${machineRows}
      </table>
      ${urlRows ? `<h4 style="color:#333;margin:12px 0 8px">Monitoreo URLs</h4><table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="background:#f5f5f5"><th style="padding:6px;text-align:left">URL</th><th style="padding:6px">Estado</th><th style="padding:6px">Resp</th></tr>${urlRows}</table>` : ''}
      <p style="color:#999;font-size:12px;margin-top:16px">Periodo: ultimos 7 dias · Alertas registradas: ${alertCount.rows[0]?.count || 0}</p>
    `;

    if (u.smtp_user && u.smtp_pass) {
      await sendEmailWithUserSMTP(u, 'Reporte Semanal', body);
    } else {
      await sendEmail(u.email, 'Reporte Semanal', body);
    }
    console.log(`[REPORT] Reporte semanal enviado a ${u.email}`);
  } catch (err) {
    console.error('[REPORT] Error:', err.message);
  }
}

// Weekly report every Monday at 8:00 (check every hour)
setInterval(async () => {
  const now = new Date();
  if (now.getUTCDay() === 1 && now.getUTCHours() === 11) {
    try {
      const users = await pool.query('SELECT id FROM users WHERE email_notifications = true');
      for (const u of users.rows) {
        generateWeeklyReport(u.id);
      }
    } catch {}
  }
}, 3600000);

// ============== WAKE-ON-LAN ==============

app.post('/api/machines/:id/wol', authenticateToken, async (req, res) => {
  try {
    const machine = await pool.query('SELECT * FROM machines WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    const m = machine.rows[0];
    if (!m.mac_address) return res.status(400).json({ error: 'MAC address no configurada. Editá la máquina y agregá la MAC.' });

    const mac = m.mac_address.replace(/[:-]/g, '');
    if (mac.length !== 12) return res.status(400).json({ error: 'MAC address invalida' });

    const dgram = require('dgram');
    const macBuf = Buffer.from(mac, 'hex');
    const magicPacket = Buffer.alloc(102);
    for (let i = 0; i < 6; i++) magicPacket[i] = 0xff;
    for (let i = 0; i < 16; i++) macBuf.copy(magicPacket, 6 + i * 6);

    const sock = dgram.createSocket('udp4');
    sock.once('listening', () => {
      sock.setBroadcast(true);
      const broadcast = m.wol_broadcast || '255.255.255.255';
      sock.send(magicPacket, 0, magicPacket.length, 9, broadcast, (err) => {
        sock.close();
        if (err) return res.status(500).json({ error: 'Error enviando WOL: ' + err.message });
        logAudit(req.user.id, 'wake_on_lan', 'machine', m.id, m.mac_address, req.ip);
        res.json({ message: `Magic packet enviado a ${m.mac_address} (${broadcast})` });
      });
    });
    sock.bind();
  } catch (error) {
    console.error('Error WOL:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== STATUS PAGE PUBLICA ==============

app.get('/status-page', (req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));

app.get('/api/public/status', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.machine_name, m.is_online, m.last_heartbeat, m.ping_ms, m.geo_city, m.geo_country,
       u.organization_id FROM machines m
       JOIN users u ON m.user_id = u.id
       WHERE u.organization_id IS NOT NULL
       ORDER BY m.machine_name`
    );

    const urlMonitors = await pool.query(
      `SELECT name, url, is_up, last_response_ms, last_check, last_error FROM url_monitors WHERE is_active = true`
    );

    const machines_list = result.rows.map(m => ({
      name: m.machine_name,
      status: m.is_online ? 'operational' : 'down',
      last_seen: m.last_heartbeat,
      ping: m.ping_ms,
      location: [m.geo_city, m.geo_country].filter(Boolean).join(', ')
    }));

    const urls = urlMonitors.rows.map(u => ({
      name: u.name || u.url,
      status: u.is_up ? 'operational' : 'down',
      response_ms: u.last_response_ms,
      last_check: u.last_check,
      error: u.is_up ? null : u.last_error
    }));

    const allUp = machines_list.every(m => m.status === 'operational') && urls.every(u => u.status === 'operational');
    const someDown = machines_list.some(m => m.status === 'down') || urls.some(u => u.status === 'down');

    res.json({
      overall: allUp ? 'operational' : someDown ? 'partial_outage' : 'major_outage',
      machines: machines_list,
      urls,
      updated_at: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== INICIAR SERVIDOR ==============

// Integrate maintenance windows into offline detector
const origOfflineDetector = true;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`ServerEyes backend corriendo en puerto ${PORT}`);
  });
}).catch(err => {
  console.error('Error al inicializar DB:', err);
  process.exit(1);
});
