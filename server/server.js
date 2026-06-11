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

async function sendEmailWithUserSMTP(user, subject, htmlBody, toOverride) {
  try {
    const nodemailer = require('nodemailer');
    const secVal = user.smtp_secure;
    const isSecure = secVal === 'ssl' || secVal === true;
    const useTls = secVal === 'tls';
    const transportOpts = user.smtp_host ? {
      host: user.smtp_host, port: user.smtp_port || 587, secure: isSecure,
      ...(useTls ? { requireTLS: true } : {}),
      ...(secVal === 'none' ? { tls: { rejectUnauthorized: false } } : {}),
      auth: { user: user.smtp_user, pass: user.smtp_pass }
    } : { service: 'gmail', auth: { user: user.smtp_user, pass: user.smtp_pass } };
    const transport = nodemailer.createTransport(transportOpts);

    const recipient = toOverride || user.email;
    await transport.sendMail({
      from: user.smtp_from || user.smtp_user,
      to: recipient,
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
    console.log(`[EMAIL-USER] Enviado a ${recipient}: ${subject}`);
  } catch (err) {
    console.error(`[EMAIL-USER] Error enviando a ${toOverride || user.email}:`, err.message);
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
app.use(express.json({ limit: '10mb' }));
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

  await pool.query(`ALTER TABLE machine_shares ADD COLUMN IF NOT EXISTS share_history BOOLEAN DEFAULT false`).catch(() => {});

  // Cambios pendientes de aprobacion
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_changes (
      id SERIAL PRIMARY KEY,
      requester_id INTEGER REFERENCES users(id),
      owner_id INTEGER REFERENCES users(id),
      change_type VARCHAR(50) NOT NULL,
      target_type VARCHAR(50) NOT NULL,
      target_id INTEGER,
      target_name VARCHAR(255),
      data JSONB,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      resolved_at TIMESTAMP,
      resolved_by INTEGER REFERENCES users(id)
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

  // Compartir URLs con tecnicos (debe ir despues de url_monitors)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS url_shares (
      id SERIAL PRIMARY KEY,
      url_id INTEGER REFERENCES url_monitors(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      shared_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(url_id, user_id)
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

  // Plans
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(20) DEFAULT 'free'`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS max_machines INTEGER DEFAULT 3`).catch(() => {});

  // Session duration + bloqueo
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_duration VARCHAR(10) DEFAULT '30d'`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS block_reason VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMP`).catch(() => {});

  // Alertas inteligentes con duracion
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS alert_duration INTEGER DEFAULT 5`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS alert_cpu_since TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS alert_ram_since TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS alert_disk_since TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS alert_ping_since TIMESTAMP`).catch(() => {});

  // Monitoreo de procesos
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS monitored_processes JSONB DEFAULT '[]'`).catch(() => {});

  // Alertas compuestas
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS compound_alert JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS compound_alert_since TIMESTAMP`).catch(() => {});

  // SLA
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS sla_target NUMERIC(5,2) DEFAULT 99.9`).catch(() => {});

  // Incidents
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incidents (
      id SERIAL PRIMARY KEY,
      machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      title VARCHAR(255),
      status VARCHAR(20) DEFAULT 'open',
      started_at TIMESTAMP DEFAULT NOW(),
      ended_at TIMESTAMP,
      duration_minutes INTEGER,
      resolution_notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS incident_events (
      id SERIAL PRIMARY KEY,
      incident_id INTEGER REFERENCES incidents(id) ON DELETE CASCADE,
      event_type VARCHAR(30) NOT NULL,
      message TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Email de soporte configurable
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('support_email', 'soporte@servereyes.app') ON CONFLICT (key) DO NOTHING`).catch(() => {});

  // Soporte / chat
  await pool.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS hidden_by_user BOOLEAN DEFAULT false`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      subject VARCHAR(255),
      status VARCHAR(20) DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reopen_count INTEGER DEFAULT 0`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_messages (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender_type VARCHAR(10) NOT NULL,
      sender_id INTEGER,
      message TEXT,
      attachments JSONB DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // SSL monitoring
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ssl_monitors (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      hostname VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      alert_days JSONB DEFAULT '[30, 14, 7, 1]',
      last_check TIMESTAMP,
      last_days_left INTEGER,
      last_issuer VARCHAR(255),
      last_expiry TIMESTAMP,
      last_status VARCHAR(20),
      last_alerted_days INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Network scans
  await pool.query(`
    CREATE TABLE IF NOT EXISTS network_scans (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      name VARCHAR(255) NOT NULL,
      subnet VARCHAR(50),
      results JSONB DEFAULT '[]',
      device_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Security info
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS security_info JSONB`).catch(() => {});

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
    // Trial Pro 14 dias
    await pool.query(
      `UPDATE users SET plan = 'pro', max_machines = 999, plan_expires_at = NOW() + INTERVAL '14 days' WHERE id = $1`,
      [user.id]
    );
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    logAudit(user.id, 'register', 'user', user.id, null, req.ip);
    res.status(201).json({ user, token, trial: true, trial_days: 14 });
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
    if (user.is_blocked) return res.status(403).json({ error: `Cuenta bloqueada: ${user.block_reason || 'Contacta al administrador'}` });

    const sessionDur = user.session_duration || '30d';
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: sessionDur });
    logAudit(user.id, 'login', 'user', user.id, null, req.ip);
    res.json({ user: { id: user.id, email: user.email, nombre: user.nombre, organization_id: user.organization_id, role: user.role || 'owner', is_admin: user.is_admin || false }, token, session_duration: sessionDur });
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

app.get('/api/auth/session', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query('SELECT session_duration FROM users WHERE id = $1', [req.user.id]);
    res.json({ session_duration: user.rows[0]?.session_duration || '30d' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/auth/session', authenticateToken, async (req, res) => {
  try {
    const { session_duration } = req.body;
    const valid = ['1h', '8h', '24h', '7d', '14d', '30d', '90d'];
    if (!valid.includes(session_duration)) return res.status(400).json({ error: 'Duracion invalida. Opciones: ' + valid.join(', ') });
    await pool.query('UPDATE users SET session_duration = $1 WHERE id = $2', [session_duration, req.user.id]);
    res.json({ message: 'Duracion de sesion actualizada', session_duration });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
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

    // Enviar email de invitacion
    const orgInfo = await pool.query('SELECT name FROM organizations WHERE id = $1', [org.rows[0].id]);
    const orgName = orgInfo.rows[0]?.name || 'una empresa';
    const inviter = await pool.query('SELECT email, nombre, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from FROM users WHERE id = $1', [req.user.id]);
    const inviterData = inviter.rows[0];
    const inviterName = inviterData?.nombre || inviterData?.email || '';
    const apkUrl = 'https://github.com/rumkus/ServerEyes/releases/latest';
    const inviteHtml = `<h3 style="color:#333">Te invitaron a unirte a <strong>${orgName}</strong></h3>
       <p style="color:#555"><strong>${inviterName}</strong> de la empresa <strong>${orgName}</strong> te invito a ser parte de su equipo en ServerEyes.</p>
       <div style="background:#f0f7ff;border-radius:8px;padding:16px;text-align:center;margin:16px 0">
         <p style="color:#888;margin:0 0 8px;font-size:13px">Tu codigo de invitacion:</p>
         <p style="font-size:28px;font-weight:800;color:#2196F3;letter-spacing:4px;margin:0">${code}</p>
       </div>
       <p style="color:#555"><strong>Para unirte:</strong></p>
       <ol style="color:#555;line-height:1.8">
         <li>Descarga la app ServerEyes: <a href="${apkUrl}" style="color:#2196F3;font-weight:600">${apkUrl}</a></li>
         <li>Instala el APK en tu celular Android</li>
         <li>Registrate con este email: <strong>${email}</strong></li>
         <li>Ve a <strong>Menu ☰ → Empresa y Equipo</strong></li>
         <li>En la seccion <strong>"¿Te invitaron a un equipo?"</strong> ingresa el codigo: <strong>${code}</strong></li>
       </ol>
       <div style="background:#fff3e0;border-radius:8px;padding:12px;margin:16px 0;border-left:4px solid #ff9800">
         <p style="color:#555;margin:0;font-size:13px"><strong>Invitado por:</strong> ${inviterName} (${inviterData?.email || ''})</p>
         <p style="color:#555;margin:4px 0 0;font-size:13px"><strong>Empresa:</strong> ${orgName}</p>
       </div>
       <p style="color:#999;font-size:12px">Si no esperabas esta invitacion, ignora este mensaje.</p>`;
    if (inviterData?.smtp_user && inviterData?.smtp_pass) {
      sendEmailWithUserSMTP(inviterData, `Invitacion a ${orgName}`, inviteHtml, email);
    } else {
      sendEmail(email, `Invitacion a ${orgName}`, inviteHtml);
    }

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

    const org = await pool.query('SELECT name, owner_id FROM organizations WHERE id = $1', [invitation.organization_id]);
    try { await sendPush(org.rows[0].owner_id, '👥 Nuevo miembro', `${user.rows[0].email} acepto la invitacion a ${org.rows[0].name}`, { type: 'invite_accepted' }); } catch(_){}
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
    await pool.query('DELETE FROM url_shares WHERE user_id = $1', [req.params.id]);
    try { await sendPush(parseInt(req.params.id), '👥 Removido del equipo', 'El owner te removio del equipo', { type: 'member_removed' }); } catch(_){}
    res.json({ message: 'Miembro removido' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Tecnico sale del grupo
app.post('/api/organization/leave', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query('SELECT organization_id FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows[0]?.organization_id) return res.status(400).json({ error: 'No perteneces a ninguna organizacion' });
    const orgId = user.rows[0].organization_id;
    const org = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [orgId]);
    if (org.rows[0]?.owner_id === req.user.id) return res.status(400).json({ error: 'El owner no puede salir de su propia organizacion' });
    await pool.query('UPDATE users SET organization_id = NULL, role = $1 WHERE id = $2', ['owner', req.user.id]);
    await pool.query('DELETE FROM machine_shares WHERE user_id = $1', [req.user.id]);
    await pool.query('DELETE FROM url_shares WHERE user_id = $1', [req.user.id]);
    const ownerId = org.rows[0]?.owner_id;
    if (ownerId) { try { await sendPush(ownerId, '👥 Miembro salio', 'Un tecnico salio del equipo', { type: 'member_left' }); } catch(_){} }
    res.json({ message: 'Saliste del grupo' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Crear cambio pendiente (tecnico propone un cambio)
app.post('/api/pending-changes', authenticateToken, async (req, res) => {
  try {
    const { change_type, target_type, target_id, target_name, data } = req.body;
    let ownerId;
    if (target_type === 'machine') {
      const m = await pool.query('SELECT user_id FROM machines WHERE id = $1', [target_id]);
      ownerId = m.rows[0]?.user_id;
    } else if (target_type === 'url') {
      const u = await pool.query('SELECT user_id FROM url_monitors WHERE id = $1', [target_id]);
      ownerId = u.rows[0]?.user_id;
    }
    if (!ownerId || ownerId === req.user.id) return res.status(400).json({ error: 'Solo para recursos compartidos' });
    const result = await pool.query(
      'INSERT INTO pending_changes (requester_id, owner_id, change_type, target_type, target_id, target_name, data) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [req.user.id, ownerId, change_type, target_type, target_id, target_name || '', JSON.stringify(data)]
    );
    // Notificar al owner
    try { await sendPush(ownerId, '📋 Cambio pendiente', `${change_type} en ${target_name || target_type}`, { type: 'pending_change' }); } catch(_){}
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Owner obtiene cambios pendientes
app.get('/api/pending-changes', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pc.*, u.email as requester_email, u.nombre as requester_name
       FROM pending_changes pc LEFT JOIN users u ON pc.requester_id = u.id
       WHERE pc.owner_id = $1 AND pc.status = 'pending'
       ORDER BY pc.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Funcion helper para resolver un cambio pendiente
async function resolvePendingChange(changeId, ownerId, doApply) {
  const pc = await pool.query('SELECT * FROM pending_changes WHERE id = $1 AND owner_id = $2 AND status = $3', [changeId, ownerId, 'pending']);
  if (pc.rows.length === 0) return null;
  const change = pc.rows[0];

  if (doApply && change.data) {
    const d = typeof change.data === 'string' ? JSON.parse(change.data) : change.data;
    if (change.change_type === 'edit' && change.target_type === 'machine') {
      const sets = []; const vals = []; let i = 1;
      for (const [k, v] of Object.entries(d)) {
        if (['machine_name','notes','alert_cpu','alert_ram','alert_disk','alert_ping','alert_offline','rdp_port','rdp_user','mac_address'].includes(k)) {
          sets.push(`${k} = $${i}`); vals.push(v); i++;
        }
      }
      if (sets.length > 0) { vals.push(change.target_id); await pool.query(`UPDATE machines SET ${sets.join(', ')} WHERE id = $${i}`, vals); }
    } else if (change.change_type === 'delete' && change.target_type === 'machine') {
      await pool.query('DELETE FROM machines WHERE id = $1 AND user_id = $2', [change.target_id, ownerId]);
    } else if (change.change_type === 'edit' && change.target_type === 'url') {
      const sets = []; const vals = []; let i = 1;
      for (const [k, v] of Object.entries(d)) {
        if (['url','name','method','expected_status','timeout_ms','interval_seconds','is_active','notify_down'].includes(k)) {
          sets.push(`${k} = $${i}`); vals.push(v); i++;
        }
      }
      if (sets.length > 0) { vals.push(change.target_id); await pool.query(`UPDATE url_monitors SET ${sets.join(', ')} WHERE id = $${i}`, vals); }
    } else if (change.change_type === 'delete' && change.target_type === 'url') {
      await pool.query('DELETE FROM url_monitors WHERE id = $1 AND user_id = $2', [change.target_id, ownerId]);
    }
  }

  await pool.query('UPDATE pending_changes SET status = $1, resolved_at = NOW(), resolved_by = $2 WHERE id = $3',
    [doApply ? 'approved' : 'rejected', ownerId, changeId]);
  try { await sendPush(change.requester_id, doApply ? '✅ Cambio aprobado' : '❌ Cambio rechazado', `${change.change_type} en ${change.target_name || change.target_type}`, { type: 'change_resolved' }); } catch(_){}
  return change;
}

// Aprobar cambio
app.post('/api/pending-changes/:id/approve', authenticateToken, async (req, res) => {
  try {
    const change = await resolvePendingChange(req.params.id, req.user.id, true);
    if (!change) return res.status(404).json({ error: 'No encontrado' });
    res.json({ message: 'Aprobado' });
  } catch (error) {
    console.error('Error aprobando:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Rechazar cambio
app.post('/api/pending-changes/:id/reject', authenticateToken, async (req, res) => {
  try {
    const change = await resolvePendingChange(req.params.id, req.user.id, false);
    if (!change) return res.status(404).json({ error: 'No encontrado' });
    res.json({ message: 'Rechazado' });
  } catch (error) {
    console.error('Error rechazando:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DEBUG: ultimo share request
let _lastShareReq = null;

// Compartir maquinas y URLs con un tecnico
app.post('/api/machines/share', authenticateToken, async (req, res) => {
  try {
    const { user_id, machine_ids, url_ids, history_ids } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    _lastShareReq = { body: req.body, owner: req.user.id, ts: new Date().toISOString() };
    console.log(`[SHARE] owner=${req.user.id} -> tech=${user_id} machines=${JSON.stringify(machine_ids)} history=${JSON.stringify(history_ids)} urls=${JSON.stringify(url_ids)}`);

    // Maquinas
    const myMachines = await pool.query('SELECT id FROM machines WHERE user_id = $1', [req.user.id]);
    const myMIds = new Set(myMachines.rows.map(m => m.id));
    await pool.query('DELETE FROM machine_shares WHERE user_id = $1 AND shared_by = $2', [user_id, req.user.id]);
    const historySet = new Set(history_ids || []);
    for (const machineId of (machine_ids || [])) {
      const owned = myMIds.has(machineId);
      const hist = historySet.has(machineId);
      console.log(`[SHARE] machine ${machineId}: owned=${owned} share_history=${hist}`);
      if (owned) {
        await pool.query(
          'INSERT INTO machine_shares (machine_id, user_id, shared_by, share_history) VALUES ($1, $2, $3, $4) ON CONFLICT (machine_id, user_id) DO UPDATE SET share_history = $4',
          [machineId, user_id, req.user.id, hist]
        );
      }
    }

    // URLs
    const myUrls = await pool.query('SELECT id FROM url_monitors WHERE user_id = $1', [req.user.id]);
    const myUIds = new Set(myUrls.rows.map(u => u.id));
    await pool.query('DELETE FROM url_shares WHERE user_id = $1 AND shared_by = $2', [user_id, req.user.id]);
    for (const urlId of (url_ids || [])) {
      if (myUIds.has(urlId)) {
        await pool.query(
          'INSERT INTO url_shares (url_id, user_id, shared_by) VALUES ($1, $2, $3) ON CONFLICT (url_id, user_id) DO NOTHING',
          [urlId, user_id, req.user.id]
        );
      }
    }

    // Verificar lo que quedo en DB
    const verify = await pool.query('SELECT machine_id, share_history FROM machine_shares WHERE user_id = $1 AND shared_by = $2', [user_id, req.user.id]);
    console.log(`[SHARE-VERIFY] DB result: ${JSON.stringify(verify.rows)}`);

    try { await sendPush(user_id, '🔄 Recursos actualizados', 'Se actualizaron las maquinas y URLs compartidas contigo', { type: 'shares_updated' }); } catch(_){}
    res.json({ message: 'Recursos compartidos', _debug: verify.rows });
  } catch (error) {
    console.error('Error compartiendo:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Obtener recursos compartidos con un tecnico
app.get('/api/machines/shared/:userId', authenticateToken, async (req, res) => {
  try {
    const machines = await pool.query(
      'SELECT machine_id, share_history FROM machine_shares WHERE user_id = $1 AND shared_by = $2',
      [req.params.userId, req.user.id]
    );
    const urls = await pool.query(
      'SELECT url_id FROM url_shares WHERE user_id = $1 AND shared_by = $2',
      [req.params.userId, req.user.id]
    );
    const result = {
      machine_ids: machines.rows.map(r => r.machine_id),
      history_ids: machines.rows.filter(r => r.share_history).map(r => r.machine_id),
      url_ids: urls.rows.map(r => r.url_id)
    };
    console.log(`[SHARED] tech=${req.params.userId} owner=${req.user.id} machines=${JSON.stringify(result.machine_ids)} history=${JSON.stringify(result.history_ids)}`);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// DEBUG: ver estado de machine_shares (TEMPORAL - eliminar despues)
app.get('/api/debug/shares', async (req, res) => {
  try {
    const shares = await pool.query('SELECT ms.*, u.email as tech_email, m.machine_name FROM machine_shares ms LEFT JOIN users u ON ms.user_id = u.id LEFT JOIN machines m ON ms.machine_id = m.id ORDER BY ms.id DESC LIMIT 20');
    res.json({ shares: shares.rows, lastShareRequest: _lastShareReq });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        const strData = {};
        for (const [k, v] of Object.entries(data)) strData[k] = String(v);
        strData.click_action = 'FLUTTER_NOTIFICATION_CLICK';
        await firebaseAdmin.messaging().send({
          token: u.fcm_token,
          notification: { title: String(title), body: String(body) },
          data: strData,
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
    const user = await pool.query('SELECT id, email, nombre, is_blocked, block_reason FROM users WHERE id = $1', [payload.id]);
    if (user.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
    if (user.rows[0].is_blocked) return res.status(403).json({ error: `Cuenta bloqueada: ${user.rows[0].block_reason || 'Contacta al administrador'}` });
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
    const { machine_key, machine_name, public_ip, local_ip, os_info, ping_ms, download_mbps, cpu_usage, ram_usage, ram_total, disk_usage, disk_total, disks, agent_version: reportedVersion, agent_logs, agent_type, services, open_ports, agent_config, backup_status, security_info } = req.body;

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
        security_info = COALESCE($18, security_info),
        last_heartbeat = NOW(),
        is_online = true,
        offline_notified = false
      WHERE machine_key = $5
      RETURNING *`,
      [public_ip, local_ip, os_info, ping_ms, machine_key, cpu_usage, ram_usage, ram_total, disk_usage, disk_total, reportedVersion, disks ? JSON.stringify(disks) : null, agent_logs || null, services ? JSON.stringify(services) : null, open_ports ? JSON.stringify(open_ports) : null, agent_config ? JSON.stringify(agent_config) : null, backup_status ? JSON.stringify(backup_status) : null, security_info ? JSON.stringify(security_info) : null]
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
        // Auto-resolver incidentes abiertos
        try {
          const openInc = await pool.query(
            `UPDATE incidents SET status = 'resolved', ended_at = NOW(),
             duration_minutes = EXTRACT(EPOCH FROM (NOW() - started_at)) / 60
             WHERE machine_id = $1 AND status = 'open' RETURNING id`,
            [updatedMachine.id]
          );
          for (const inc of openInc.rows) {
            await pool.query(
              `INSERT INTO incident_events (incident_id, event_type, message) VALUES ($1, 'resolved', 'Maquina volvio a estar online')`,
              [inc.id]
            );
          }
        } catch (ie) {}
      }
    }

    // Alertas inteligentes con duracion
    if (updatedMachine && updatedMachine.user_id) {
      const alertCooldown = updatedMachine.last_alert_at ? (Date.now() - new Date(updatedMachine.last_alert_at).getTime()) > 300000 : true;
      const durationMin = updatedMachine.alert_duration || 5;
      const now = new Date();

      // Trackear cuando empezo cada umbral excedido
      const cpuOver = updatedMachine.alert_cpu && cpu_usage !== undefined && cpu_usage >= updatedMachine.alert_cpu;
      const ramPct = ram_usage && ram_total ? Math.round((ram_usage / ram_total) * 100) : 0;
      const ramOver = updatedMachine.alert_ram && ramPct >= updatedMachine.alert_ram;
      const pingOver = updatedMachine.alert_ping && ping_ms && ping_ms >= updatedMachine.alert_ping;
      let diskOver = false;
      if (disks && Array.isArray(disks) && disks.length > 0) {
        const perDisk = updatedMachine.alert_disks || {};
        const globalDisk = updatedMachine.alert_disk;
        for (const disk of disks) {
          if (disk.total > 0) {
            const threshold = perDisk[disk.drive] || globalDisk;
            if (threshold && Math.round((disk.used / disk.total) * 100) >= threshold) diskOver = true;
          }
        }
      } else if (updatedMachine.alert_disk && disk_usage && disk_total && Math.round((disk_usage / disk_total) * 100) >= updatedMachine.alert_disk) {
        diskOver = true;
      }

      // Actualizar timestamps de inicio de exceso
      await pool.query(
        `UPDATE machines SET
          alert_cpu_since = CASE WHEN $1 THEN COALESCE(alert_cpu_since, NOW()) ELSE NULL END,
          alert_ram_since = CASE WHEN $2 THEN COALESCE(alert_ram_since, NOW()) ELSE NULL END,
          alert_disk_since = CASE WHEN $3 THEN COALESCE(alert_disk_since, NOW()) ELSE NULL END,
          alert_ping_since = CASE WHEN $4 THEN COALESCE(alert_ping_since, NOW()) ELSE NULL END
        WHERE id = $5`,
        [cpuOver, ramOver, diskOver, pingOver, updatedMachine.id]
      );

      // Solo alertar si el umbral lleva excedido >= alert_duration minutos
      if (alertCooldown) {
        const alerts = [];
        const durMs = durationMin * 60000;
        if (cpuOver && updatedMachine.alert_cpu_since && (now - new Date(updatedMachine.alert_cpu_since)) >= durMs) {
          alerts.push(`CPU al ${cpu_usage}% por ${durationMin}+ min (umbral: ${updatedMachine.alert_cpu}%)`);
        }
        if (ramOver && updatedMachine.alert_ram_since && (now - new Date(updatedMachine.alert_ram_since)) >= durMs) {
          alerts.push(`RAM al ${ramPct}% por ${durationMin}+ min (umbral: ${updatedMachine.alert_ram}%)`);
        }
        if (diskOver && updatedMachine.alert_disk_since && (now - new Date(updatedMachine.alert_disk_since)) >= durMs) {
          alerts.push(`Disco excedido por ${durationMin}+ min`);
        }
        if (pingOver && updatedMachine.alert_ping_since && (now - new Date(updatedMachine.alert_ping_since)) >= durMs) {
          alerts.push(`Ping ${ping_ms}ms por ${durationMin}+ min (umbral: ${updatedMachine.alert_ping}ms)`);
        }
        if (alerts.length > 0) {
          sendPush(updatedMachine.user_id, `⚠️ Alerta: ${updatedMachine.machine_name}`, alerts.join(' | '), { type: 'threshold_alert', machineId: String(updatedMachine.id) });
          await pool.query('UPDATE machines SET last_alert_at = NOW() WHERE id = $1', [updatedMachine.id]);
        }
      }

      // Monitoreo de procesos
      const monProcs = updatedMachine.monitored_processes || [];
      if (monProcs.length > 0 && services && Array.isArray(services)) {
        const runningNames = services.filter(s => s.state === 'RUNNING').map(s => (s.name || '').toLowerCase());
        const downProcs = monProcs.filter(p => !runningNames.includes(p.toLowerCase()));
        if (downProcs.length > 0 && alertCooldown) {
          sendPush(updatedMachine.user_id, `🔴 Proceso caido: ${updatedMachine.machine_name}`, downProcs.join(', ') + ' no esta corriendo', { type: 'process_alert', machineId: String(updatedMachine.id) });
          await pool.query('UPDATE machines SET last_alert_at = NOW() WHERE id = $1', [updatedMachine.id]);
        }
      }

      // Alertas compuestas (ej: CPU > 90 AND RAM > 85 por X min)
      const compRule = updatedMachine.compound_alert;
      if (compRule && compRule.conditions && compRule.conditions.length > 0) {
        const vals = { cpu: cpu_usage, ram: ramPct, ping: ping_ms || 0 };
        const allMet = compRule.conditions.every((c) => {
          const v = vals[c.metric];
          return v !== undefined && v >= (c.threshold || 0);
        });
        if (allMet) {
          if (!updatedMachine.compound_alert_since) {
            await pool.query('UPDATE machines SET compound_alert_since = NOW() WHERE id = $1', [updatedMachine.id]);
          } else {
            const sinceDur = (now - new Date(updatedMachine.compound_alert_since)) / 60000;
            if (sinceDur >= (compRule.duration || 5) && alertCooldown) {
              const desc = compRule.conditions.map(c => `${c.metric.toUpperCase()} >= ${c.threshold}%`).join(' + ');
              sendPush(updatedMachine.user_id, `🔥 Alerta compuesta: ${updatedMachine.machine_name}`, `${desc} por ${Math.round(sinceDur)} min`, { type: 'compound_alert', machineId: String(updatedMachine.id) });
              await pool.query('UPDATE machines SET last_alert_at = NOW() WHERE id = $1', [updatedMachine.id]);
            }
          }
        } else {
          if (updatedMachine.compound_alert_since) {
            await pool.query('UPDATE machines SET compound_alert_since = NULL WHERE id = $1', [updatedMachine.id]);
          }
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
      `SELECT m.*, true as is_shared, ms.share_history, u.email as owner_email, u.nombre as owner_name
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

    // Verificar limite del plan
    const userPlan = await pool.query('SELECT plan, max_machines FROM users WHERE id = $1', [req.user.id]);
    const { plan, max_machines } = userPlan.rows[0] || { plan: 'free', max_machines: 3 };
    if (plan !== 'pro' && plan !== 'enterprise') {
      const count = await pool.query('SELECT COUNT(*) as cnt FROM machines WHERE user_id = $1', [req.user.id]);
      if (parseInt(count.rows[0].cnt) >= max_machines) {
        return res.status(403).json({ error: `Limite del plan ${plan}: maximo ${max_machines} maquinas. Actualiza a Pro para agregar mas.` });
      }
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
    if (req.body.alert_duration !== undefined) { fields.push(`alert_duration = $${idx++}`); values.push(req.body.alert_duration || 5); }
    if (req.body.monitored_processes !== undefined) { fields.push(`monitored_processes = $${idx++}`); values.push(JSON.stringify(req.body.monitored_processes || [])); }
    if (req.body.compound_alert !== undefined) { fields.push(`compound_alert = $${idx++}`); values.push(req.body.compound_alert ? JSON.stringify(req.body.compound_alert) : null); }

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
// Sparkline data: ultimos 12 puntos de CPU/RAM por maquina del usuario
app.get('/api/machines/sparklines', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.id, (
        SELECT json_agg(json_build_object('cpu', h.cpu, 'ram', h.ram, 'ping', h.ping) ORDER BY h.time)
        FROM (SELECT cpu, ram, ping, time FROM metrics_history WHERE machine_id = m.id ORDER BY time DESC LIMIT 12) h
      ) as points
      FROM machines m WHERE m.user_id = $1 AND m.is_online = true`,
      [req.user.id]
    );
    const data = {};
    for (const row of result.rows) {
      if (row.points) data[row.id] = row.points.reverse();
    }
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

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

// ============== TRIAL EXPIRATION CHECK (cada hora) ==============
setInterval(async () => {
  try {
    const expired = await pool.query(
      `UPDATE users SET plan = 'free', max_machines = 3
       WHERE plan = 'pro' AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()
       RETURNING id, email`
    );
    if (expired.rows.length > 0) {
      console.log(`[TRIAL] ${expired.rows.length} trial(s) expirado(s): ${expired.rows.map(u => u.email).join(', ')}`);
    }
  } catch (e) { console.error('Error trial check:', e.message); }
}, 3600000);

// ============== SSL CERTIFICATE CHECKER (cada 6 horas) ==============
async function checkSSLCert(hostname) {
  return new Promise((resolve) => {
    const tls = require('tls');
    const socket = tls.connect(443, hostname, { servername: hostname, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.destroy();
      if (!cert || !cert.valid_to) return resolve(null);
      const expiresAt = new Date(cert.valid_to);
      const daysLeft = Math.ceil((expiresAt - Date.now()) / 86400000);
      resolve({ issuer: cert.issuer?.O || cert.issuer?.CN || '?', expires_at: expiresAt, days_left: daysLeft, status: daysLeft <= 0 ? 'expired' : daysLeft <= 14 ? 'warning' : 'ok' });
    });
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
}

setInterval(async () => {
  try {
    const monitors = await pool.query('SELECT sm.*, u.id as uid FROM ssl_monitors sm JOIN users u ON sm.user_id = u.id');
    for (const mon of monitors.rows) {
      const result = await checkSSLCert(mon.hostname);
      if (!result) {
        await pool.query('UPDATE ssl_monitors SET last_check = NOW(), last_status = $1 WHERE id = $2', ['error', mon.id]);
        continue;
      }
      await pool.query(
        'UPDATE ssl_monitors SET last_check = NOW(), last_days_left = $1, last_issuer = $2, last_expiry = $3, last_status = $4 WHERE id = $5',
        [result.days_left, result.issuer, result.expires_at, result.status, mon.id]
      );
      const alertDays = mon.alert_days || [30, 14, 7, 1];
      const matchedDay = alertDays.sort((a, b) => b - a).find(d => result.days_left <= d);
      if (matchedDay !== undefined && matchedDay !== mon.last_alerted_days) {
        sendPush(mon.user_id, `🔒 SSL: ${mon.name || mon.hostname}`, `Certificado vence en ${result.days_left} dias (${result.expires_at.toLocaleDateString('es')})`, { type: 'ssl_alert' });
        await pool.query('UPDATE ssl_monitors SET last_alerted_days = $1 WHERE id = $2', [matchedDay, mon.id]);
        console.log(`[SSL] Alerta: ${mon.hostname} vence en ${result.days_left} dias`);
      }
    }
  } catch (e) { console.error('Error SSL check:', e.message); }
}, 6 * 3600000);
setTimeout(async () => {
  try {
    const monitors = await pool.query('SELECT id FROM ssl_monitors WHERE last_check IS NULL LIMIT 10');
    if (monitors.rows.length > 0) console.log(`[SSL] ${monitors.rows.length} certificados pendientes de chequeo inicial`);
  } catch {}
}, 30000);

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
        // Auto-crear incidente
        try {
          const inc = await pool.query(
            `INSERT INTO incidents (machine_id, user_id, title, status, started_at)
             VALUES ($1, $2, $3, 'open', NOW()) RETURNING id`,
            [machine.id, machine.user_id, `${machine.machine_name} offline`]
          );
          await pool.query(
            `INSERT INTO incident_events (incident_id, event_type, message) VALUES ($1, 'detected', $2)`,
            [inc.rows[0].id, `Maquina dejo de responder. Ultima IP: ${machine.public_ip || 'desconocida'}`]
          );
        } catch (ie) { console.error('Error creando incidente:', ie.message); }
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
    const users = await pool.query('SELECT id, email, nombre, is_admin, plan, max_machines, created_at, fcm_token IS NOT NULL as has_push, is_blocked, block_reason, blocked_at FROM users ORDER BY id');
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

// Bloquear/desbloquear usuario
app.post('/api/admin/block-user', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { user_id, is_blocked, block_reason } = req.body;
    if (is_blocked) {
      await pool.query('UPDATE users SET is_blocked = true, block_reason = $1, blocked_at = NOW() WHERE id = $2', [block_reason || 'Bloqueado por administrador', user_id]);
    } else {
      await pool.query('UPDATE users SET is_blocked = false, block_reason = NULL, blocked_at = NULL WHERE id = $1', [user_id]);
    }
    logAudit(req.user.id, is_blocked ? 'block_user' : 'unblock_user', 'user', user_id, JSON.stringify({ reason: block_reason }), req.ip);
    res.json({ message: is_blocked ? 'Usuario bloqueado' : 'Usuario desbloqueado' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Historial de metricas de una maquina
app.get('/api/machines/:id/metrics', authenticateToken, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const machine = await pool.query(
      'SELECT id, user_id FROM machines WHERE id = $1 AND (user_id = $2 OR EXISTS (SELECT 1 FROM machine_shares ms WHERE ms.machine_id = $1 AND ms.user_id = $2))',
      [req.params.id, req.user.id]
    );
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });

    if (machine.rows[0].user_id !== req.user.id) {
      const shareCheck = await pool.query('SELECT share_history FROM machine_shares WHERE machine_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      console.log(`[METRICS] user=${req.user.id} machine=${req.params.id} share_history=${shareCheck.rows[0]?.share_history} rows=${shareCheck.rows.length}`);
      if (!shareCheck.rows[0]?.share_history) return res.json([]);
    }

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
    res.json({ smtp_host: u.smtp_host || '', smtp_port: u.smtp_port || 587, smtp_secure: u.smtp_secure || 'tls', smtp_user: u.smtp_user || '', smtp_from: u.smtp_from || '', email_notifications: u.email_notifications !== false, configured: !!u.smtp_user });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Guardar config SMTP del usuario
app.post('/api/auth/smtp', authenticateToken, async (req, res) => {
  try {
    const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from, email_notifications } = req.body;
    await pool.query(
      'UPDATE users SET smtp_host = $1, smtp_port = $2, smtp_secure = $3, smtp_user = $4, smtp_from = $5, email_notifications = $6 WHERE id = $7',
      [smtp_host || null, smtp_port || 587, smtp_secure || 'tls', smtp_user || null, smtp_from || null, email_notifications !== false, req.user.id]
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

// ── PLAN INFO ──
app.get('/api/plan', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query('SELECT plan, max_machines, plan_expires_at FROM users WHERE id = $1', [req.user.id]);
    const machineCount = await pool.query('SELECT COUNT(*) as cnt FROM machines WHERE user_id = $1', [req.user.id]);
    const p = user.rows[0] || {};
    res.json({ plan: p.plan || 'free', max_machines: p.max_machines || 3, current_machines: parseInt(machineCount.rows[0].cnt), expires_at: p.plan_expires_at });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Admin: cambiar plan de usuario
app.post('/api/admin/set-plan', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { user_id, plan, max_machines } = req.body;
    const maxM = plan === 'pro' ? 999 : plan === 'enterprise' ? 9999 : (max_machines || 3);
    await pool.query('UPDATE users SET plan = $1, max_machines = $2 WHERE id = $3', [plan || 'free', maxM, user_id]);
    res.json({ message: 'Plan actualizado' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── SLA TRACKING ──
app.get('/api/machines/:id/sla', authenticateToken, async (req, res) => {
  try {
    const machine = await pool.query(
      'SELECT id, sla_target FROM machines WHERE id = $1 AND (user_id = $2 OR EXISTS (SELECT 1 FROM machine_shares ms WHERE ms.machine_id = $1 AND ms.user_id = $2))',
      [req.params.id, req.user.id]
    );
    if (machine.rows.length === 0) return res.status(404).json({ error: 'No encontrada' });
    const slaTarget = parseFloat(machine.rows[0].sla_target) || 99.9;

    const months = [];
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const start = d.toISOString();
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).toISOString();
      const events = await pool.query(
        `SELECT status, timestamp FROM uptime_log WHERE machine_id = $1 AND timestamp BETWEEN $2 AND $3 ORDER BY timestamp ASC`,
        [req.params.id, start, end]
      );
      const priorEvent = await pool.query(
        `SELECT status FROM uptime_log WHERE machine_id = $1 AND timestamp < $2 ORDER BY timestamp DESC LIMIT 1`,
        [req.params.id, start]
      );
      let lastStatus = priorEvent.rows.length > 0 ? priorEvent.rows[0].status : 'offline';
      let onlineMs = 0, totalMs = 0;
      const monthStart = d.getTime();
      const monthEnd = Math.min(new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).getTime(), now.getTime());
      let cursor = monthStart;

      for (const evt of events.rows) {
        const evtTime = new Date(evt.timestamp).getTime();
        if (lastStatus === 'online') onlineMs += evtTime - cursor;
        cursor = evtTime;
        lastStatus = evt.status;
      }
      if (lastStatus === 'online') onlineMs += monthEnd - cursor;
      totalMs = monthEnd - monthStart;

      const uptime = totalMs > 0 ? parseFloat(((onlineMs / totalMs) * 100).toFixed(3)) : 0;
      months.push({
        month: d.toLocaleDateString('es', { month: 'short', year: 'numeric' }),
        uptime,
        target: slaTarget,
        met: uptime >= slaTarget,
        online_hours: Math.round(onlineMs / 3600000),
        total_hours: Math.round(totalMs / 3600000),
        downtime_minutes: Math.round((totalMs - onlineMs) / 60000)
      });
    }
    res.json({ sla_target: slaTarget, months });
  } catch (error) {
    console.error('Error SLA:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.put('/api/machines/:id/sla', authenticateToken, async (req, res) => {
  try {
    const { sla_target } = req.body;
    await pool.query('UPDATE machines SET sla_target = $1 WHERE id = $2 AND user_id = $3', [sla_target || 99.9, req.params.id, req.user.id]);
    res.json({ message: 'SLA actualizado' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── INCIDENTS ──
app.get('/api/incidents', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.*, m.machine_name,
       (SELECT COUNT(*) FROM incident_events ie WHERE ie.incident_id = i.id) as event_count
       FROM incidents i JOIN machines m ON i.machine_id = m.id
       WHERE i.user_id = $1
       ORDER BY i.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/incidents/:id', authenticateToken, async (req, res) => {
  try {
    const inc = await pool.query(
      `SELECT i.*, m.machine_name FROM incidents i JOIN machines m ON i.machine_id = m.id WHERE i.id = $1 AND i.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (inc.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    const events = await pool.query(
      `SELECT ie.*, u.email as user_email FROM incident_events ie LEFT JOIN users u ON ie.created_by = u.id WHERE ie.incident_id = $1 ORDER BY ie.created_at ASC`,
      [req.params.id]
    );
    res.json({ ...inc.rows[0], events: events.rows });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/incidents/:id/events', authenticateToken, async (req, res) => {
  try {
    const { event_type, message } = req.body;
    const inc = await pool.query('SELECT id FROM incidents WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (inc.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    await pool.query(
      'INSERT INTO incident_events (incident_id, event_type, message, created_by) VALUES ($1, $2, $3, $4)',
      [req.params.id, event_type || 'update', message, req.user.id]
    );
    res.json({ message: 'Evento agregado' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/incidents/:id/resolve', authenticateToken, async (req, res) => {
  try {
    const { resolution_notes } = req.body;
    const inc = await pool.query('SELECT id, started_at FROM incidents WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (inc.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    const dur = Math.round((Date.now() - new Date(inc.rows[0].started_at).getTime()) / 60000);
    await pool.query(
      `UPDATE incidents SET status = 'resolved', ended_at = NOW(), duration_minutes = $1, resolution_notes = $2 WHERE id = $3`,
      [dur, resolution_notes || null, req.params.id]
    );
    await pool.query(
      `INSERT INTO incident_events (incident_id, event_type, message, created_by) VALUES ($1, 'resolved', $2, $3)`,
      [req.params.id, resolution_notes || 'Incidente resuelto manualmente', req.user.id]
    );
    res.json({ message: 'Incidente resuelto' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── UPGRADE/DOWNGRADE PLAN ──
app.post('/api/plan/upgrade', authenticateToken, async (req, res) => {
  try {
    const { plan, payment_id } = req.body;
    if (!['pro', 'enterprise'].includes(plan)) return res.status(400).json({ error: 'Plan invalido' });
    // TODO: validar pago con MercadoPago/Stripe usando payment_id
    const expiresAt = plan === 'pro' ? "NOW() + INTERVAL '30 days'" : "NOW() + INTERVAL '365 days'";
    const maxM = plan === 'pro' ? 999 : 9999;
    await pool.query(
      `UPDATE users SET plan = $1, max_machines = $2, plan_expires_at = ${expiresAt} WHERE id = $3`,
      [plan, maxM, req.user.id]
    );
    logAudit(req.user.id, 'plan_upgrade', 'user', req.user.id, JSON.stringify({ plan, payment_id }), req.ip);
    res.json({ message: `Plan actualizado a ${plan}`, plan });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── SSL CERTIFICATE MONITORING ──
app.post('/api/ssl-check', authenticateToken, async (req, res) => {
  try {
    const { hostname } = req.body;
    if (!hostname) return res.status(400).json({ error: 'hostname requerido' });
    const tls = require('tls');
    const socket = tls.connect(443, hostname, { servername: hostname, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.destroy();
      if (!cert || !cert.valid_to) return res.json({ error: 'No se pudo obtener certificado' });
      const expiresAt = new Date(cert.valid_to);
      const daysLeft = Math.ceil((expiresAt - Date.now()) / 86400000);
      res.json({
        hostname, issuer: cert.issuer?.O || cert.issuer?.CN || 'Desconocido',
        subject: cert.subject?.CN || hostname,
        valid_from: cert.valid_from, valid_to: cert.valid_to,
        expires_at: expiresAt.toISOString(), days_left: daysLeft,
        status: daysLeft <= 0 ? 'expired' : daysLeft <= 14 ? 'warning' : 'ok'
      });
    });
    socket.on('error', (err) => { res.json({ hostname, error: err.message, status: 'error' }); });
    socket.on('timeout', () => { socket.destroy(); res.json({ hostname, error: 'Timeout', status: 'error' }); });
  } catch (error) {
    res.status(500).json({ error: 'Error: ' + error.message });
  }
});

// ── SOPORTE / CHAT ──
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 4 } });

// Listar tickets del usuario
app.get('/api/support/tickets', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id = t.id AND sm.sender_type = 'admin' AND sm.created_at > t.updated_at) as unread
       FROM support_tickets t WHERE t.user_id = $1 AND (t.hidden_by_user = false OR t.hidden_by_user IS NULL) ORDER BY t.updated_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Crear ticket (con mensaje opcional)
app.post('/api/support/tickets', authenticateToken, async (req, res) => {
  try {
    const { subject, message } = req.body;
    const result = await pool.query(
      'INSERT INTO support_tickets (user_id, subject) VALUES ($1, $2) RETURNING *',
      [req.user.id, subject || 'Consulta de soporte']
    );
    const ticket = result.rows[0];
    if (message && message.trim()) {
      const validation = validateMessage(message.trim());
      const msg = validation.ok ? validation.message : message.trim();
      await pool.query(
        'INSERT INTO support_messages (ticket_id, sender_type, sender_id, message) VALUES ($1, $2, $3, $4)',
        [ticket.id, 'user', req.user.id, msg]
      );
    }
    res.status(201).json(ticket);
  } catch (error) { console.error('Error crear ticket:', error); res.status(500).json({ error: 'Error interno' }); }
});

// Mensajes de un ticket
app.get('/api/support/tickets/:id/messages', authenticateToken, async (req, res) => {
  try {
    const ticket = await pool.query('SELECT id FROM support_tickets WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (ticket.rows.length === 0) return res.status(404).json({ error: 'Ticket no encontrado' });
    const messages = await pool.query(
      `SELECT sm.*, u.email as sender_email, u.nombre as sender_name
       FROM support_messages sm LEFT JOIN users u ON sm.sender_id = u.id
       WHERE sm.ticket_id = $1 ORDER BY sm.created_at ASC`,
      [req.params.id]
    );
    await pool.query('UPDATE support_tickets SET updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json(messages.rows);
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Filtro de malas palabras
const badWords = ['puta','mierda','carajo','pendejo','idiota','estupido','imbecil','pelotudo','boludo','forro','concha','verga','cojudo','hijo de puta','la concha','hdp','ctm','ptm','fuck','shit','bitch','asshole','bastard','dick','cunt'];
function filterBadWords(text) {
  if (!text) return { clean: text, hasBadWords: false };
  let clean = text;
  let found = false;
  for (const w of badWords) {
    const regex = new RegExp(w, 'gi');
    if (regex.test(clean)) { found = true; clean = clean.replace(regex, '*'.repeat(w.length)); }
  }
  return { clean, hasBadWords: found };
}

function validateMessage(message) {
  if (!message) return { ok: true, message: '' };
  if (message.length > 1000) return { ok: false, error: 'El mensaje supera los 1000 caracteres. Adjuntalo como archivo TXT.' };
  const filtered = filterBadWords(message);
  return { ok: true, message: filtered.clean, warned: filtered.hasBadWords };
}

// Enviar mensaje (usuario)
const optionalUpload = (req, res, next) => {
  if (req.headers['content-type']?.includes('multipart')) { upload.array('files', 4)(req, res, next); }
  else next();
};
app.post('/api/support/tickets/:id/messages', authenticateToken, optionalUpload, async (req, res) => {
  try {
    const ticket = await pool.query('SELECT id, status FROM support_tickets WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (ticket.rows.length === 0) return res.status(404).json({ error: 'Ticket no encontrado' });
    if (ticket.rows[0].status === 'closed') return res.status(400).json({ error: 'Este ticket esta cerrado. Reabrilo o crea uno nuevo.' });
    const raw = req.body.message || '';
    const validation = validateMessage(raw);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    const message = validation.message;
    const attachments = (req.files || []).map(f => ({
      name: f.originalname, size: f.size, type: f.mimetype,
      data: f.buffer.toString('base64')
    }));
    if (attachments.length > 4) return res.status(400).json({ error: 'Maximo 4 adjuntos' });
    const tooLarge = attachments.find(a => a.size > 3 * 1024 * 1024);
    if (tooLarge) return res.status(400).json({ error: 'Adjuntos no pueden superar 3MB cada uno' });
    await pool.query(
      'INSERT INTO support_messages (ticket_id, sender_type, sender_id, message, attachments) VALUES ($1, $2, $3, $4, $5)',
      [req.params.id, 'user', req.user.id, message, JSON.stringify(attachments)]
    );
    await pool.query('UPDATE support_tickets SET status = $1, updated_at = NOW() WHERE id = $2', ['open', req.params.id]);
    res.json({ message: 'Mensaje enviado' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Admin: listar todos los tickets
app.get('/api/admin/support/tickets', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, u.email, u.nombre, COALESCE(t.hidden_by_user, false) as hidden_by_user,
       (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id = t.id) as msg_count,
       (SELECT message FROM support_messages sm WHERE sm.ticket_id = t.id ORDER BY sm.created_at DESC LIMIT 1) as last_message
       FROM support_tickets t JOIN users u ON t.user_id = u.id
       ORDER BY t.updated_at DESC`
    );
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Admin: ver mensajes de un ticket
app.get('/api/admin/support/tickets/:id/messages', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const messages = await pool.query(
      `SELECT sm.*, u.email as sender_email, u.nombre as sender_name
       FROM support_messages sm LEFT JOIN users u ON sm.sender_id = u.id
       WHERE sm.ticket_id = $1 ORDER BY sm.created_at ASC`,
      [req.params.id]
    );
    res.json(messages.rows);
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Admin: responder ticket
app.post('/api/admin/support/tickets/:id/reply', authenticateToken, requireAdmin, optionalUpload, async (req, res) => {
  try {
    const raw = req.body.message || '';
    const validation = validateMessage(raw);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    const message = validation.message;
    const attachments = (req.files || []).map(f => ({
      name: f.originalname, size: f.size, type: f.mimetype,
      data: f.buffer.toString('base64')
    }));
    await pool.query(
      'INSERT INTO support_messages (ticket_id, sender_type, sender_id, message, attachments) VALUES ($1, $2, $3, $4, $5)',
      [req.params.id, 'admin', req.user.id, message, JSON.stringify(attachments)]
    );
    // Track first response time
    await pool.query('UPDATE support_tickets SET updated_at = NOW(), first_response_at = COALESCE(first_response_at, NOW()) WHERE id = $1', [req.params.id]);
    const ticket = await pool.query('SELECT user_id FROM support_tickets WHERE id = $1', [req.params.id]);
    if (ticket.rows[0]) {
      sendPush(ticket.rows[0].user_id, '💬 Respuesta de soporte', message.substring(0, 100), { type: 'support' });
    }
    res.json({ message: 'Respuesta enviada' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Admin: cerrar ticket
app.post('/api/admin/support/tickets/:id/close', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE support_tickets SET status = $1, updated_at = NOW(), closed_at = NOW() WHERE id = $2', ['closed', req.params.id]);
    await pool.query(
      `INSERT INTO support_messages (ticket_id, sender_type, sender_id, message) VALUES ($1, 'system', $2, 'Ticket cerrado por soporte')`,
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Ticket cerrado' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// User: reabrir ticket
app.post('/api/support/tickets/:id/reopen', authenticateToken, async (req, res) => {
  try {
    const ticket = await pool.query('SELECT id FROM support_tickets WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (ticket.rows.length === 0) return res.status(404).json({ error: 'Ticket no encontrado' });
    await pool.query('UPDATE support_tickets SET status = $1, updated_at = NOW(), reopen_count = reopen_count + 1 WHERE id = $2', ['open', req.params.id]);
    await pool.query(
      `INSERT INTO support_messages (ticket_id, sender_type, sender_id, message) VALUES ($1, 'system', $2, 'Ticket reabierto por el usuario')`,
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Ticket reabierto' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// User: ocultar ticket (no borra, solo oculta para el usuario)
app.delete('/api/support/tickets/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE support_tickets SET hidden_by_user = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Ticket eliminado' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// User: cerrar ticket
app.post('/api/support/tickets/:id/close', authenticateToken, async (req, res) => {
  try {
    const ticket = await pool.query('SELECT id FROM support_tickets WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (ticket.rows.length === 0) return res.status(404).json({ error: 'Ticket no encontrado' });
    await pool.query('UPDATE support_tickets SET status = $1, updated_at = NOW(), closed_at = NOW() WHERE id = $2', ['closed', req.params.id]);
    await pool.query(
      `INSERT INTO support_messages (ticket_id, sender_type, sender_id, message) VALUES ($1, 'system', $2, 'Ticket cerrado por el usuario')`,
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Ticket cerrado' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Metrics de soporte
app.get('/api/admin/support/metrics', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) as cnt FROM support_tickets');
    const open = await pool.query("SELECT COUNT(*) as cnt FROM support_tickets WHERE status = 'open'");
    const closed = await pool.query("SELECT COUNT(*) as cnt FROM support_tickets WHERE status = 'closed'");
    const avgFirstResponse = await pool.query("SELECT AVG(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60) as avg_min FROM support_tickets WHERE first_response_at IS NOT NULL");
    const avgResolution = await pool.query("SELECT AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 60) as avg_min FROM support_tickets WHERE closed_at IS NOT NULL");
    const totalMessages = await pool.query('SELECT COUNT(*) as cnt FROM support_messages');
    const reopened = await pool.query("SELECT SUM(reopen_count) as cnt FROM support_tickets WHERE reopen_count > 0");
    const byDay = await pool.query("SELECT DATE(created_at) as day, COUNT(*) as cnt FROM support_tickets WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY day ORDER BY day");
    res.json({
      total: parseInt(total.rows[0].cnt),
      open: parseInt(open.rows[0].cnt),
      closed: parseInt(closed.rows[0].cnt),
      total_messages: parseInt(totalMessages.rows[0].cnt),
      reopened: parseInt(reopened.rows[0].cnt || 0),
      avg_first_response_min: Math.round(parseFloat(avgFirstResponse.rows[0].avg_min) || 0),
      avg_resolution_min: Math.round(parseFloat(avgResolution.rows[0].avg_min) || 0),
      tickets_by_day: byDay.rows
    });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// Email de soporte configurable
app.get('/api/admin/support-email', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM app_settings WHERE key = 'support_email'");
    res.json({ email: r.rows[0]?.value || 'soporte@servereyes.app' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/admin/support-email', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requerido' });
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('support_email', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [email]);
    res.json({ message: 'Email actualizado' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// ── NETWORK SCANS ──
app.get('/api/network-scans', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, subnet, device_count, created_at FROM network_scans WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/network-scans/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM network_scans WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/network-scans', authenticateToken, async (req, res) => {
  try {
    const { name, subnet, results } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    const deviceCount = Array.isArray(results) ? results.length : 0;
    const result = await pool.query(
      'INSERT INTO network_scans (user_id, name, subnet, results, device_count) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, name, subnet || null, JSON.stringify(results || []), deviceCount]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/api/network-scans/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM network_scans WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Eliminado' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/network-scans/:id/compare/:otherId', authenticateToken, async (req, res) => {
  try {
    const [scan1, scan2] = await Promise.all([
      pool.query('SELECT * FROM network_scans WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]),
      pool.query('SELECT * FROM network_scans WHERE id = $1 AND user_id = $2', [req.params.otherId, req.user.id])
    ]);
    if (scan1.rows.length === 0 || scan2.rows.length === 0) return res.status(404).json({ error: 'Escaneo no encontrado' });
    const s1 = scan1.rows[0]; const s2 = scan2.rows[0];
    const r1 = s1.results || []; const r2 = s2.results || [];
    const ips1 = new Set(r1.map((d) => d.ip));
    const ips2 = new Set(r2.map((d) => d.ip));
    const newDevices = r2.filter((d) => !ips1.has(d.ip));
    const removedDevices = r1.filter((d) => !ips2.has(d.ip));
    const changedDevices = r2.filter((d) => {
      const prev = r1.find((p) => p.hostname && d.hostname && p.hostname === d.hostname && p.ip !== d.ip);
      return prev;
    }).map((d) => {
      const prev = r1.find((p) => p.hostname === d.hostname);
      return { hostname: d.hostname, old_ip: prev.ip, new_ip: d.ip };
    });
    res.json({
      scan1: { id: s1.id, name: s1.name, date: s1.created_at, count: r1.length },
      scan2: { id: s2.id, name: s2.name, date: s2.created_at, count: r2.length },
      new_devices: newDevices,
      removed_devices: removedDevices,
      ip_changes: changedDevices,
      same: r2.filter((d) => ips1.has(d.ip)).length
    });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// ── NETWORK SCAN (via agent) ──
app.post('/api/network-scan/request', authenticateToken, async (req, res) => {
  try {
    const { machine_id } = req.body;
    if (!machine_id) return res.status(400).json({ error: 'machine_id requerido' });
    const machine = await pool.query('SELECT id FROM machines WHERE id = $1 AND (user_id = $2 OR EXISTS (SELECT 1 FROM machine_shares ms WHERE ms.machine_id = $1 AND ms.user_id = $2))', [machine_id, req.user.id]);
    if (machine.rows.length === 0) return res.status(404).json({ error: 'Maquina no encontrada' });
    await pool.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      ['scan_request_' + machine_id, JSON.stringify({ requested_at: new Date().toISOString(), user_id: req.user.id })]);
    res.json({ message: 'Escaneo solicitado. Resultado en ~30 segundos.' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/network-scan/result/:machineId', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM app_settings WHERE key = $1", ['scan_result_' + req.params.machineId]);
    if (result.rows.length === 0) return res.json({ status: 'pending' });
    res.json(JSON.parse(result.rows[0].value));
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// ── SSL MONITORS CRUD ──
app.get('/api/ssl-monitors', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ssl_monitors WHERE user_id = $1 ORDER BY hostname', [req.user.id]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/ssl-monitors', authenticateToken, async (req, res) => {
  try {
    const { hostname, name, alert_days } = req.body;
    if (!hostname) return res.status(400).json({ error: 'hostname requerido' });
    const h = hostname.replace(/^https?:\/\//, '').split('/')[0];
    const days = alert_days || [30, 14, 7, 1];
    const result = await pool.query(
      'INSERT INTO ssl_monitors (user_id, hostname, name, alert_days) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, h, name || h, JSON.stringify(days)]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/api/ssl-monitors/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM ssl_monitors WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Eliminado' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.put('/api/ssl-monitors/:id', authenticateToken, async (req, res) => {
  try {
    const { alert_days, name } = req.body;
    const fields = [];
    const vals = [];
    let idx = 1;
    if (alert_days !== undefined) { fields.push(`alert_days = $${idx++}`); vals.push(JSON.stringify(alert_days)); }
    if (name !== undefined) { fields.push(`name = $${idx++}`); vals.push(name); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
    vals.push(req.params.id, req.user.id);
    await pool.query(`UPDATE ssl_monitors SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`, vals);
    res.json({ message: 'Actualizado' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// ── INCIDENTS PDF EXPORT ──
app.get('/api/incidents/export/pdf', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.*, m.machine_name FROM incidents i JOIN machines m ON i.machine_id = m.id WHERE i.user_id = $1 ORDER BY i.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    const incidents = result.rows;
    const open = incidents.filter(i => i.status === 'open').length;
    const resolved = incidents.filter(i => i.status === 'resolved').length;
    const totalDownMin = incidents.reduce((a, i) => a + (i.duration_minutes || 0), 0);

    let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ServerEyes - Reporte de Incidentes</title>
    <style>body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#333}
    h1{color:#1a1a2e;border-bottom:3px solid #00d4ff;padding-bottom:10px}
    .stats{display:flex;gap:20px;margin:20px 0}
    .stat{background:#f5f5f5;border-radius:10px;padding:16px;flex:1;text-align:center}
    .stat .num{font-size:28px;font-weight:800}
    .stat .label{font-size:12px;color:#888}
    table{width:100%;border-collapse:collapse;margin-top:20px}
    th{background:#1a1a2e;color:#fff;padding:10px;text-align:left;font-size:12px}
    td{padding:8px 10px;border-bottom:1px solid #eee;font-size:12px}
    .open{color:#f44336;font-weight:700} .resolved{color:#4caf50;font-weight:700}
    .footer{margin-top:30px;text-align:center;color:#999;font-size:11px}
    </style></head><body>
    <h1>👁 ServerEyes — Reporte de Incidentes</h1>
    <p style="color:#888">Generado: ${new Date().toLocaleString('es')}</p>
    <div class="stats">
      <div class="stat"><div class="num">${incidents.length}</div><div class="label">Total</div></div>
      <div class="stat"><div class="num" style="color:#f44336">${open}</div><div class="label">Abiertos</div></div>
      <div class="stat"><div class="num" style="color:#4caf50">${resolved}</div><div class="label">Resueltos</div></div>
      <div class="stat"><div class="num">${Math.round(totalDownMin)}</div><div class="label">Min offline</div></div>
    </div>
    <table><thead><tr><th>Maquina</th><th>Titulo</th><th>Estado</th><th>Inicio</th><th>Fin</th><th>Duracion</th><th>Resolucion</th></tr></thead><tbody>
    ${incidents.map(i => `<tr>
      <td>${i.machine_name}</td><td>${i.title}</td>
      <td class="${i.status}">${i.status === 'open' ? 'ABIERTO' : 'RESUELTO'}</td>
      <td>${new Date(i.started_at).toLocaleString('es')}</td>
      <td>${i.ended_at ? new Date(i.ended_at).toLocaleString('es') : '—'}</td>
      <td>${i.duration_minutes ? Math.round(i.duration_minutes) + ' min' : 'En curso'}</td>
      <td>${i.resolution_notes || '—'}</td>
    </tr>`).join('')}
    </tbody></table>
    <div class="footer">ServerEyes — Monitoreo de servidores en tiempo real</div>
    </body></html>`;

    res.set({ 'Content-Type': 'text/html', 'Content-Disposition': 'attachment; filename="incidentes-servereyes.html"' });
    res.send(html);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
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
    const own = await pool.query('SELECT *, false as is_shared FROM url_monitors WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    const shared = await pool.query(
      `SELECT um.*, true as is_shared, u.email as owner_email, u.nombre as owner_name
       FROM url_monitors um
       JOIN url_shares us ON us.url_id = um.id
       LEFT JOIN users u ON um.user_id = u.id
       WHERE us.user_id = $1
       ORDER BY um.created_at DESC`,
      [req.user.id]
    );
    res.json([...own.rows, ...shared.rows]);
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
