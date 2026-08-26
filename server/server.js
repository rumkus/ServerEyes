require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

// Sin default: un secreto hardcodeado hace que cualquiera pueda firmar tokens
// validos si la variable falta en el entorno. Preferimos no arrancar.
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_SECRET_VIEJO = 'servereyes-secret-key-change-in-production';
if (!JWT_SECRET || JWT_SECRET === JWT_SECRET_VIEJO) {
  console.error('[FATAL] JWT_SECRET no esta definido (o sigue siendo el default publico).');
  console.error('[FATAL] Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
  process.exit(1);
}
if (JWT_SECRET.length < 32) {
  console.warn(`[SEGURIDAD] JWT_SECRET tiene solo ${JWT_SECRET.length} caracteres. Conviene rotarlo a 48+.`);
}

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (no crash):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection (no crash):', reason);
});

const crypto = require('crypto');

// Firma HMAC con la machine_key, que solo conocen el servidor y ese agente.
// El agente verifica antes de ejecutar un comando o aplicar un update, asi que
// cualquiera que logre responderle en lugar del servidor (DNS secuestrado,
// proxy, servidor falso) no puede inyectarle codigo.
function firmarParaMaquina(machineKey, ...partes) {
  return crypto.createHmac('sha256', String(machineKey)).update(partes.join('\u0000')).digest('hex');
}

// Cifrado en reposo de secretos de usuario (hoy: contraseñas SMTP).
// Clave dedicada si existe SMTP_ENC_KEY; si no, derivada del JWT_SECRET.
const SMTP_ENC_INFO = 'servereyes-smtp-v1';
const derivarClaveSmtp = (base) =>
  Buffer.from(crypto.hkdfSync('sha256', Buffer.from(base), Buffer.alloc(0), Buffer.from(SMTP_ENC_INFO), 32));

// La primera clave de la lista es con la que ciframos; las demas solo sirven
// para descifrar lo que quedo guardado con una clave anterior. Asi cambiar de
// clave no deja ilegible nada: el arranque re-cifra lo viejo con la principal.
let _clavesSmtp = null;
function clavesSmtp() {
  if (_clavesSmtp) return _clavesSmtp;
  const claves = [];
  if (process.env.SMTP_ENC_KEY) {
    claves.push(derivarClaveSmtp(process.env.SMTP_ENC_KEY));
    // Para rotar SMTP_ENC_KEY: dejar la anterior aca hasta el siguiente arranque.
    if (process.env.SMTP_ENC_KEY_ANTERIOR) claves.push(derivarClaveSmtp(process.env.SMTP_ENC_KEY_ANTERIOR));
    // Y la derivada del JWT, con la que se cifro antes de que existiera la variable.
    claves.push(derivarClaveSmtp(JWT_SECRET));
  } else {
    console.warn('[SEGURIDAD] SMTP_ENC_KEY no definida: se cifra con una clave derivada de JWT_SECRET.');
    console.warn('[SEGURIDAD] Si rotas JWT_SECRET, los usuarios tendran que volver a cargar su clave SMTP.');
    claves.push(derivarClaveSmtp(JWT_SECRET));
  }
  _clavesSmtp = claves;
  return _clavesSmtp;
}
function cifrarSecreto(texto) {
  if (!texto) return texto;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clavesSmtp()[0], iv);
  const ct = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return ['enc:v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
// Devuelve el texto claro, o null si esa clave no es la correcta. El tag de
// GCM hace que probar claves sea seguro: con la equivocada falla, no devuelve
// basura.
function descifrarConClave(valor, clave) {
  try {
    const [, , ivB64, tagB64, ctB64] = valor.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', clave, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}
function descifrarSecreto(valor) {
  if (!valor || typeof valor !== 'string' || !valor.startsWith('enc:v1:')) return valor; // legado en claro
  for (const clave of clavesSmtp()) {
    const claro = descifrarConClave(valor, clave);
    if (claro !== null) return claro;
  }
  console.error('[SEGURIDAD] No se pudo descifrar un secreto SMTP con ninguna clave conocida');
  return null;
}

// Destinatarios extra de un monitor. Es correo saliente hacia terceros, asi
// que se valida el formato, se normaliza y se limita la cantidad.
const MAX_CORREOS_POR_MONITOR = 10;
function normalizarCorreos(lista) {
  if (!Array.isArray(lista)) return null;
  const limpios = [];
  for (const bruto of lista) {
    const e = String(bruto || '').trim().toLowerCase();
    if (!e) continue;
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) return { error: `Correo invalido: ${e}` };
    if (!limpios.includes(e)) limpios.push(e);
  }
  if (limpios.length > MAX_CORREOS_POR_MONITOR) return { error: `Maximo ${MAX_CORREOS_POR_MONITOR} correos por monitor` };
  return limpios;
}

// La URL con la que se arman los enlaces de los mails. Cuando el dominio
// propio apunte al servicio, alcanza con definir PUBLIC_URL.
function urlPublica() {
  return (process.env.PUBLIC_URL || 'https://servereyes.app').replace(/\/+$/, '');
}

// Pone la lista de destinatarios de un monitor en el estado que pidio el dueño.
// Los nuevos entran como pendientes y reciben el pedido de permiso; los que
// saco se eliminan. A los que ya estaban no se los vuelve a molestar.
async function sincronizarDestinatarios(tipo, monitorId, correos, owner, nombreMonitor, queSeVigila) {
  const deseados = Array.isArray(correos) ? correos : [];
  const actuales = await pool.query('SELECT email, estado FROM monitor_recipients WHERE tipo = $1 AND monitor_id = $2', [tipo, monitorId]);
  const yaEstaban = actuales.rows.map(r => r.email);

  const sacados = yaEstaban.filter(e => !deseados.includes(e));
  if (sacados.length > 0) {
    await pool.query('DELETE FROM monitor_recipients WHERE tipo = $1 AND monitor_id = $2 AND email = ANY($3)', [tipo, monitorId, sacados]);
  }

  const nuevos = deseados.filter(e => !yaEstaban.includes(e));
  for (const email of nuevos) {
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(
      'INSERT INTO monitor_recipients (tipo, monitor_id, email, token, agregado_por, lote) VALUES ($1, $2, $3, $4, $5, $4) ON CONFLICT (tipo, monitor_id, email) DO NOTHING',
      [tipo, monitorId, email, token, owner.id]
    );
    await pedirPermiso(owner, email, token, nombreMonitor, queSeVigila);
  }
  await recomputarNotifyEmails(tipo, monitorId);
  return { agregados: nuevos.length, quitados: sacados.length };
}

// La tabla manda: notify_emails queda como reflejo para que el campo del
// editor muestre lo mismo que la pantalla de asignar. Sin esto, cargar por un
// lado y mirar por el otro da la sensacion de que no se guardo nada.
async function recomputarNotifyEmails(tipo, monitorId) {
  try {
    const tabla = tipo === 'ssl' ? 'ssl_monitors' : 'url_monitors';
    const q = await pool.query(
      "SELECT email FROM monitor_recipients WHERE tipo = $1 AND monitor_id = $2 AND estado <> 'baja' ORDER BY email",
      [tipo, monitorId]
    );
    await pool.query(`UPDATE ${tabla} SET notify_emails = $1 WHERE id = $2`,
      [JSON.stringify(q.rows.map(r => r.email)), monitorId]);
  } catch (e) {
    console.error('[AVISO] Error sincronizando notify_emails:', e.message);
  }
}

// El mail que decide todo: quien lo agrego, que se vigila, que le va a llegar,
// y los dos botones. Sin esto, la persona recibe alertas que nunca pidio.
async function pedirPermiso(owner, email, token, nombreMonitor, queSeVigila) {
  const base = urlPublica();
  const quien = owner.nombre ? `${owner.nombre} (${owner.email})` : owner.email;
  const cuerpo = `
    <p style="font-size:15px;color:#333;margin:0 0 14px">Hola,</p>
    <p style="font-size:15px;color:#333;margin:0 0 14px">
      <strong>${quien}</strong> te agrego para que recibas los avisos de <strong>${nombreMonitor}</strong>
      a traves de ServerEyes, un servicio que vigila sitios web y avisa cuando algo anda mal.
    </p>
    <div style="background:#f5f7fa;border-left:3px solid #2196F3;border-radius:0 8px 8px 0;padding:14px 16px;margin:16px 0">
      <p style="margin:0 0 6px;font-size:13px;color:#666"><strong>Que se vigila</strong></p>
      <p style="margin:0;font-size:14px;color:#333">${queSeVigila}</p>
    </div>
    <p style="font-size:14px;color:#666;margin:0 0 14px">
      Si aceptas, vas a recibir un mail unicamente cuando el estado cambie: cuando se caiga y cuando
      vuelva a funcionar, o cuando el certificado este por vencer. No mandamos resumenes ni publicidad,
      y podes darte de baja cuando quieras desde el pie de cualquier aviso.
    </p>
    <div style="text-align:center;margin:26px 0 18px">
      <a href="${base}/notificaciones/confirmar/${token}"
         style="display:inline-block;background:#2196F3;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 28px;border-radius:8px">Si, quiero recibir los avisos</a>
    </div>
    <p style="text-align:center;margin:0 0 18px">
      <a href="${base}/notificaciones/baja/${token}" style="color:#999;font-size:13px">No me interesa, no me escriban mas</a>
    </p>
    <p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:14px;margin:0">
      Hasta que aceptes no vas a recibir ningun aviso. Si no reconoces a ${owner.email}, ignora este mensaje
      o usa el enlace de arriba para que no te volvamos a escribir.
    </p>`;
  try {
    const asunto = `${owner.nombre || owner.email} quiere avisarte sobre ${nombreMonitor}`;
    if (owner.smtp_user && owner.smtp_pass) await sendEmailWithUserSMTP(owner, asunto, cuerpo, email);
    else await sendEmail(email, asunto, cuerpo);
    console.log(`[AVISO] Permiso pedido a ${email} para ${nombreMonitor}`);
  } catch (e) {
    console.error(`[AVISO] No se pudo pedir permiso a ${email}: ${e.message}`);
  }
}

const SUB_DESTINATARIOS_URL = `,
       (SELECT json_agg(json_build_object('email', mr.email, 'estado', mr.estado) ORDER BY mr.email)
        FROM monitor_recipients mr WHERE mr.tipo = 'url' AND mr.monitor_id = um.id) as destinatarios`;

async function traerDuenio(userId) {
  const q = await pool.query('SELECT id, email, nombre, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from FROM users WHERE id = $1', [userId]);
  return q.rows[0] || null;
}

// Al borrar un monitor no queda nada que justifique guardar las direcciones de
// sus destinatarios.
async function borrarDestinatarios(tipo, monitorId) {
  try {
    const r = await pool.query('DELETE FROM monitor_recipients WHERE tipo = $1 AND monitor_id = $2', [tipo, monitorId]);
    if (r.rowCount > 0) console.log(`[AVISO] ${r.rowCount} destinatario(s) eliminado(s) con el monitor ${tipo}/${monitorId}`);
  } catch (e) {
    console.error('[AVISO] Error borrando destinatarios:', e.message);
  }
}

// Igual que pedirPermiso, pero por varios sitios a la vez: un mail, una lista,
// un clic. Agregar a alguien a diez monitores no puede significar diez mails.
async function pedirPermisoLote(owner, email, token, items) {
  const base = urlPublica();
  const quien = owner.nombre ? `${owner.nombre} (${owner.email})` : owner.email;
  const filas = items.map(i =>
    `<li style="margin-bottom:6px"><strong>${i.nombre}</strong><br><span style="color:#888;font-size:13px">${i.que}</span></li>`
  ).join('');
  const cuerpo = `
    <p style="font-size:15px;color:#333;margin:0 0 14px">Hola,</p>
    <p style="font-size:15px;color:#333;margin:0 0 14px">
      <strong>${quien}</strong> te agrego para que recibas los avisos de ${items.length === 1 ? 'este sitio' : `estos ${items.length} sitios`}
      a traves de ServerEyes, un servicio que vigila sitios web y avisa cuando algo anda mal.
    </p>
    <div style="background:#f5f7fa;border-left:3px solid #2196F3;border-radius:0 8px 8px 0;padding:14px 16px;margin:16px 0">
      <ul style="margin:0;padding-left:18px;font-size:14px;color:#333">${filas}</ul>
    </div>
    <p style="font-size:14px;color:#666;margin:0 0 14px">
      Si aceptas, vas a recibir un mail unicamente cuando el estado cambie: cuando algo se caiga y cuando
      vuelva a funcionar, o cuando un certificado este por vencer. No mandamos resumenes ni publicidad,
      y podes darte de baja cuando quieras desde el pie de cualquier aviso.
    </p>
    <div style="text-align:center;margin:26px 0 18px">
      <a href="${base}/notificaciones/confirmar/${token}"
         style="display:inline-block;background:#2196F3;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 28px;border-radius:8px">Si, quiero recibir ${items.length === 1 ? 'los avisos' : 'todos estos avisos'}</a>
    </div>
    <p style="text-align:center;margin:0 0 18px">
      <a href="${base}/notificaciones/baja/${token}" style="color:#999;font-size:13px">No me interesa, no me escriban mas</a>
    </p>
    <p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:14px;margin:0">
      Hasta que aceptes no vas a recibir ningun aviso. Si no reconoces a ${owner.email}, ignora este mensaje
      o usa el enlace de arriba para que no te volvamos a escribir.
    </p>`;
  try {
    const asunto = items.length === 1
      ? `${owner.nombre || owner.email} quiere avisarte sobre ${items[0].nombre}`
      : `${owner.nombre || owner.email} quiere avisarte sobre ${items.length} sitios`;
    if (owner.smtp_user && owner.smtp_pass) await sendEmailWithUserSMTP(owner, asunto, cuerpo, email);
    else await sendEmail(email, asunto, cuerpo);
    console.log(`[AVISO] Permiso pedido a ${email} por ${items.length} monitor(es)`);
  } catch (e) {
    console.error(`[AVISO] No se pudo pedir permiso a ${email}: ${e.message}`);
  }
}

// Solo los que aceptaron. Devuelve el token de cada uno para poner el enlace
// de baja en el pie del aviso.
async function destinatariosConfirmados(tipo, monitorId) {
  try {
    const q = await pool.query(
      "SELECT email, token FROM monitor_recipients WHERE tipo = $1 AND monitor_id = $2 AND estado = 'confirmado'",
      [tipo, monitorId]
    );
    return q.rows;
  } catch (e) {
    console.error('[AVISO] Error leyendo destinatarios:', e.message);
    return [];
  }
}

// Manda el aviso a los destinatarios extra, usando el SMTP del dueño si lo
// tiene configurado. Nunca corta el flujo: si un envio falla, se loguea.
async function avisarAExtras(ownerId, tipo, monitorId, asunto, cuerpoHtml) {
  const destinatarios = await destinatariosConfirmados(tipo, monitorId);
  if (destinatarios.length === 0) return;
  try {
    const q = await pool.query('SELECT email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from FROM users WHERE id = $1', [ownerId]);
    const u = q.rows[0];
    if (!u) return;
    const base = urlPublica();
    for (const d of destinatarios) {
      // El enlace de baja va en cada aviso: es la unica forma que tiene el
      // destinatario de salirse sin pedirselo al dueño del monitor.
      const conPie = cuerpoHtml + `
        <p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:14px;margin-top:22px">
          Recibis esto porque aceptaste los avisos de este sitio.
          <a href="${base}/notificaciones/baja/${d.token}" style="color:#999">Darme de baja</a>
        </p>`;
      try {
        if (u.smtp_user && u.smtp_pass) await sendEmailWithUserSMTP(u, asunto, conPie, d.email);
        else await sendEmail(d.email, asunto, conPie);
      } catch (e) {
        console.error(`[AVISO] No se pudo avisar a ${d.email}: ${e.message}`);
      }
    }
    console.log(`[AVISO] ${asunto} -> ${destinatarios.length} destinatario(s) confirmado(s)`);
  } catch (e) {
    console.error('[AVISO] Error avisando a extras:', e.message);
  }
}

// Email (Nodemailer)
// El SMTP que usa toda la aplicacion cuando el usuario no configuro el suyo.
// Se guarda en app_settings para poder editarlo desde el panel de admin sin
// redesplegar; las variables de entorno quedan como respaldo.
let _transporteGlobal = null;   // null = sin resolver, false = no hay configurado
let _remitenteGlobal = null;

function invalidarTransporteGlobal() { _transporteGlobal = null; _remitenteGlobal = null; }

async function configSmtpGlobal() {
  const q = await pool.query("SELECT key, value FROM app_settings WHERE key LIKE 'smtp_%'");
  const c = {};
  for (const r of q.rows) c[r.key.replace(/^smtp_/, '')] = r.value;
  return c;
}

async function transporteGlobal() {
  if (_transporteGlobal !== null) return _transporteGlobal;
  const nodemailer = require('nodemailer');
  let c = {};
  try { c = await configSmtpGlobal(); } catch (e) { /* base todavia no lista */ }

  const host = c.host || process.env.SMTP_HOST;
  const user = c.user || process.env.SMTP_USER;
  const pass = c.pass ? descifrarSecreto(c.pass) : process.env.SMTP_PASS;
  const seguridad = c.secure || (process.env.SMTP_SECURE === 'true' ? 'ssl' : 'tls');
  _remitenteGlobal = c.from || process.env.SMTP_FROM || user || 'servereyes@noreply.com';

  try {
    if (host && user && pass) {
      _transporteGlobal = nodemailer.createTransport({
        host,
        port: parseInt(c.port || process.env.SMTP_PORT || '587'),
        secure: seguridad === 'ssl',
        ...(seguridad === 'tls' ? { requireTLS: true } : {}),
        auth: { user, pass }
      });
      console.log(`[EMAIL] SMTP global: ${user}@${host} (remitente ${_remitenteGlobal})`);
    } else if (user && pass) {
      _transporteGlobal = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
      console.log('[EMAIL] SMTP global por Gmail:', user);
    } else {
      _transporteGlobal = false;
      console.log('[EMAIL] Sin SMTP global configurado: los usuarios sin SMTP propio no reciben mails');
    }
  } catch (err) {
    console.error('[EMAIL] Error armando el SMTP global:', err.message);
    _transporteGlobal = false;
  }
  return _transporteGlobal;
}

async function sendEmail(to, subject, body) {
  const emailTransporter = await transporteGlobal();
  if (!emailTransporter) return;
  try {
    await emailTransporter.sendMail({
      from: _remitenteGlobal,
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
      auth: { user: user.smtp_user, pass: descifrarSecreto(user.smtp_pass) }
    } : { service: 'gmail', auth: { user: user.smtp_user, pass: descifrarSecreto(user.smtp_pass) } };
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
  // firebase-admin 14 elimino la API con namespace (admin.credential.cert,
  // admin.messaging()). La modular es la unica que queda.
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getMessaging } = require('firebase-admin/messaging');
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
      const fbApp = initializeApp({ credential: cert(serviceAccount) });
      // Conservamos la forma .messaging().send() para no tocar los tres lugares
      // del archivo que mandan push.
      firebaseAdmin = { messaging: () => getMessaging(fbApp) };
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
// 60mb para que entre el agente en base64. El segundo express.json que habia
// aca, de 10mb, era codigo muerto: el primero ya parseo el body, pero hacia
// creer que el limite real era 10mb.
app.use(express.json({ limit: '60mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

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
  // El texto cifrado es mas largo que el original: 255 no alcanza.
  await pool.query(`ALTER TABLE users ALTER COLUMN smtp_pass TYPE TEXT`).catch(() => {});
  // Cifrar las que quedaron guardadas en claro de antes.
  try {
    const enClaro = await pool.query("SELECT id, smtp_pass FROM users WHERE smtp_pass IS NOT NULL AND smtp_pass <> '' AND smtp_pass NOT LIKE 'enc:v1:%'");
    for (const row of enClaro.rows) {
      await pool.query('UPDATE users SET smtp_pass = $1 WHERE id = $2', [cifrarSecreto(row.smtp_pass), row.id]);
    }
    if (enClaro.rows.length > 0) console.log(`[SEGURIDAD] ${enClaro.rows.length} contraseña(s) SMTP cifradas en reposo`);
  } catch (e) {
    console.error('[SEGURIDAD] Error migrando contraseñas SMTP:', e.message);
  }
  // Re-cifrar lo que haya quedado con una clave anterior. Pasa al definir
  // SMTP_ENC_KEY por primera vez (estaba cifrado con la derivada del JWT) y en
  // cada rotacion posterior. Sin esto, cambiar la clave dejaba las contraseñas
  // ilegibles y el usuario se enteraba recien cuando no le llegaba un mail.
  try {
    const principal = clavesSmtp()[0];
    const cifradas = await pool.query("SELECT id, smtp_pass FROM users WHERE smtp_pass LIKE 'enc:v1:%'");
    let recifradas = 0, perdidas = 0;
    for (const row of cifradas.rows) {
      if (descifrarConClave(row.smtp_pass, principal) !== null) continue; // ya esta con la clave actual
      const claro = descifrarSecreto(row.smtp_pass);
      if (claro === null) { perdidas++; console.error(`[SEGURIDAD] Contraseña SMTP del usuario ${row.id} ilegible: tendra que volver a cargarla`); continue; }
      await pool.query('UPDATE users SET smtp_pass = $1 WHERE id = $2', [cifrarSecreto(claro), row.id]);
      recifradas++;
    }
    if (recifradas > 0) console.log(`[SEGURIDAD] ${recifradas} contraseña(s) SMTP re-cifradas con la clave actual`);
    if (perdidas > 0) console.error(`[SEGURIDAD] ${perdidas} contraseña(s) SMTP no se pudieron recuperar`);
  } catch (e) {
    console.error('[SEGURIDAD] Error re-cifrando contraseñas SMTP:', e.message);
  }
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_from VARCHAR(255)`).catch(() => {});
  // Sin registro de cuando salio el ultimo, la unica forma de no repetirlo era
  // acertar la hora exacta, y si el servidor se reiniciaba en esa hora la
  // semana se perdia sin dejar rastro.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_report_at TIMESTAMP`).catch(() => {});
  // Al estrenar la columna todos quedan en NULL, y NULL significa "nunca se le
  // mando": sin esto, el primer arranque le dispararia el reporte a todos los
  // usuarios de una. Se los da por al dia y el primero sale el lunes que viene.
  await pool.query(`UPDATE users SET last_report_at = NOW() WHERE last_report_at IS NULL`).catch(() => {});
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

  // Mismo esquema para el client de escritorio. Antes no existia: se podia
  // publicar una version del client pero no alojar el binario en ningun lado.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_files (
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
  // Pagina de estado publica: apagada por defecto y con un slug impredecible.
  // Antes /api/public/status devolvia el inventario de TODAS las organizaciones
  // a cualquiera que abriera la URL.
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status_slug VARCHAR(64)`).catch(() => {});
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status_enabled BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_status_slug ON organizations (status_slug) WHERE status_slug IS NOT NULL`).catch(() => {});
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

  // Destinatarios extra por monitor: al cliente dueño de ese sitio le llegan
  // los avisos de su propio sitio, sin darle acceso a la cuenta.
  await pool.query(`ALTER TABLE url_monitors ADD COLUMN IF NOT EXISTS notify_emails JSONB DEFAULT '[]'`).catch(() => {});
  await pool.query(`ALTER TABLE ssl_monitors ADD COLUMN IF NOT EXISTS notify_emails JSONB DEFAULT '[]'`).catch(() => {});

  // Las URLs de descarga guardadas apuntan al host con el que se subio el
  // binario. Si cambio el dominio, los agentes seguirian yendo al viejo.
  try {
    const base = urlPublica();
    const r = await pool.query(
      `UPDATE app_settings
       SET value = $1 || substring(value from position('/api/' in value))
       WHERE key IN ('agent_url', 'client_url')
         AND value LIKE 'http%'
         AND position('/api/' in value) > 0
         AND value NOT LIKE $2`,
      [base, base + '%']
    );
    if (r.rowCount > 0) console.log(`[SETUP] ${r.rowCount} URL(s) de descarga reapuntadas a ${base}`);
  } catch (e) {
    console.error('[SETUP] Error reapuntando URLs de descarga:', e.message);
  }

  // Nadie recibe avisos por haber sido cargado en una lista: primero se le
  // pide permiso y recien cuando acepta pasa a confirmado. La baja la puede
  // hacer solo, desde el pie de cualquier aviso, sin depender del dueño.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitor_recipients (
      id SERIAL PRIMARY KEY,
      tipo VARCHAR(10) NOT NULL,
      monitor_id INTEGER NOT NULL,
      email VARCHAR(255) NOT NULL,
      estado VARCHAR(12) NOT NULL DEFAULT 'pendiente',
      token VARCHAR(64) NOT NULL,
      agregado_por INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      confirmado_at TIMESTAMP,
      baja_at TIMESTAMP,
      UNIQUE (tipo, monitor_id, email)
    )
  `);
  // Un alta masiva manda un solo mail por varios monitores: el lote los agrupa
  // para que un unico clic confirme todos los que se pidieron juntos.
  await pool.query(`ALTER TABLE monitor_recipients ADD COLUMN IF NOT EXISTS lote VARCHAR(64)`).catch(() => {});
  await pool.query(`UPDATE monitor_recipients SET lote = token WHERE lote IS NULL`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recipients_token ON monitor_recipients (token)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recipients_lote ON monitor_recipients (lote)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recipients_monitor ON monitor_recipients (tipo, monitor_id)`).catch(() => {});
  // monitor_id no puede tener clave foranea porque apunta a dos tablas segun el
  // tipo, asi que un monitor borrado deja destinatarios huerfanos: direcciones
  // de gente guardadas sin ningun monitor que las justifique.
  try {
    const h = await pool.query(`
      DELETE FROM monitor_recipients mr
      WHERE (mr.tipo = 'url' AND NOT EXISTS (SELECT 1 FROM url_monitors u WHERE u.id = mr.monitor_id))
         OR (mr.tipo = 'ssl' AND NOT EXISTS (SELECT 1 FROM ssl_monitors sm WHERE sm.id = mr.monitor_id))
    `);
    if (h.rowCount > 0) console.log(`[AVISO] ${h.rowCount} destinatario(s) huerfano(s) eliminado(s)`);
  } catch (e) {
    console.error('[AVISO] Error limpiando huerfanos:', e.message);
  }

  // Historial de chequeos de URL: sin esto no habia forma de saber que fallo,
  // porque last_error se borra en el primer chequeo exitoso posterior.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS url_check_history (
      id SERIAL PRIMARY KEY,
      url_id INTEGER REFERENCES url_monitors(id) ON DELETE CASCADE,
      checked_at TIMESTAMP DEFAULT NOW(),
      is_up BOOLEAN NOT NULL,
      status INTEGER,
      response_ms INTEGER,
      error TEXT,
      attempts INTEGER DEFAULT 1,
      notified BOOLEAN DEFAULT false
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_url_check_history ON url_check_history (url_id, checked_at DESC)`).catch(() => {});

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
  // Inventario de hardware y red que manda el agente una vez por dia
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS inventory JSONB`).catch(() => {});
  // Cuantas veces seguidas se le ofrecio el mismo update a esta maquina sin que
  // cambie de version. Sirve para cortar el bucle de updates que no prenden.
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS update_offers INTEGER DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS update_offer_version VARCHAR(40)`).catch(() => {});
  // Guarda "tipo:version" y no solo la version: en una maquina puede haber
  // instalados el agente y el client de escritorio, y los dos latidos escriben
  // en este mismo registro. Sin el tipo, los intentos fallidos de uno frenaban
  // los updates legitimos del otro.
  await pool.query(`ALTER TABLE machines ALTER COLUMN update_offer_version TYPE VARCHAR(40)`).catch(() => {});
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS inventory_at TIMESTAMP`).catch(() => {});

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

// ELIMINADO: /api/auth/clerk-login
//
// Emitia un JWT de sesion a partir de un clerk_id y un email tomados del body,
// sin verificar ningun token firmado por Clerk. Conocer un email alcanzaba para
// obtener un token valido de esa cuenta, y desde ahi encolar comandos remotos
// que los agentes ejecutan con exec(). Solo lo usaba mobile-expo, discontinuada.
//
// Si alguna vez vuelve a hacer falta login con Clerk: exigir el JWT de Clerk en
// el header, verificarlo contra su JWKS, y usar el "sub" del token verificado
// como identidad — nunca el email que manda el cliente.
app.post('/api/auth/clerk-login', (req, res) => {
  console.warn('[SEGURIDAD] Intento de uso de /api/auth/clerk-login (eliminado) desde', req.ip);
  res.status(410).json({ error: 'Endpoint eliminado. Usa /api/auth/login.' });
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
      await borrarDestinatarios('url', change.target_id);
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
// Compartir maquinas y URLs con un tecnico
app.post('/api/machines/share', authenticateToken, async (req, res) => {
  try {
    const { user_id, machine_ids, url_ids, history_ids } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });

    console.log(`[SHARE-RAW] body=${JSON.stringify(req.body)} types: machine_ids=${typeof machine_ids}/${Array.isArray(machine_ids)} history_ids=${typeof history_ids}/${Array.isArray(history_ids)}`);

    const safeMachineIds = (machine_ids || []).map(Number).filter(n => !isNaN(n));
    const safeHistoryIds = (history_ids || []).map(Number).filter(n => !isNaN(n));
    const safeUrlIds = (url_ids || []).map(Number).filter(n => !isNaN(n));
    console.log(`[SHARE-SAFE] machines=${JSON.stringify(safeMachineIds)} history=${JSON.stringify(safeHistoryIds)} urls=${JSON.stringify(safeUrlIds)}`);

    const myMachines = await pool.query('SELECT id FROM machines WHERE user_id = $1', [req.user.id]);
    const myMIds = new Set(myMachines.rows.map(m => m.id));
    await pool.query('DELETE FROM machine_shares WHERE user_id = $1 AND shared_by = $2', [user_id, req.user.id]);
    const historySet = new Set(safeHistoryIds);
    for (const machineId of safeMachineIds) {
      if (myMIds.has(machineId)) {
        await pool.query(
          'INSERT INTO machine_shares (machine_id, user_id, shared_by, share_history) VALUES ($1, $2, $3, $4) ON CONFLICT (machine_id, user_id) DO UPDATE SET share_history = $4',
          [machineId, user_id, req.user.id, historySet.has(machineId)]
        );
      }
    }

    const myUrls = await pool.query('SELECT id FROM url_monitors WHERE user_id = $1', [req.user.id]);
    const myUIds = new Set(myUrls.rows.map(u => u.id));
    await pool.query('DELETE FROM url_shares WHERE user_id = $1 AND shared_by = $2', [user_id, req.user.id]);
    for (const urlId of safeUrlIds) {
      if (myUIds.has(urlId)) {
        await pool.query(
          'INSERT INTO url_shares (url_id, user_id, shared_by) VALUES ($1, $2, $3) ON CONFLICT (url_id, user_id) DO NOTHING',
          [urlId, user_id, req.user.id]
        );
      }
    }

    try { await sendPush(user_id, '🔄 Recursos actualizados', 'Se actualizaron las maquinas y URLs compartidas contigo', { type: 'shares_updated' }); } catch(_){}
    res.json({ message: 'Recursos compartidos' });
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
    res.json({
      machine_ids: machines.rows.map(r => r.machine_id),
      history_ids: machines.rows.filter(r => r.share_history).map(r => r.machine_id),
      url_ids: urls.rows.map(r => r.url_id)
    });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ELIMINADOS: /api/debug/shares, /api/debug/force-history/:machineId y
// /api/debug/test-metrics/:machineId/:userId
//
// Eran endpoints de diagnostico sin autenticacion. Exponian la relacion
// usuario-maquina de toda la base, y force-history ademas escribia:
// ponia share_history = true para todos los shares de una maquina, o sea que
// cualquiera podia darse acceso al historial de metricas ajeno.

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
    const { machine_key, machine_name, public_ip, local_ip, os_info, ping_ms, download_mbps, cpu_usage, ram_usage, ram_total, disk_usage, disk_total, disks, agent_version: reportedVersion, agent_logs, agent_type, services, open_ports, agent_config, backup_status, security_info, inventory } = req.body;

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
        inventory = COALESCE($19, inventory),
        -- Solo se mueve la fecha cuando llega inventario nuevo, no en cada latido
        inventory_at = CASE WHEN $19::jsonb IS NULL THEN inventory_at ELSE NOW() END,
        last_heartbeat = NOW(),
        is_online = true,
        offline_notified = false
      WHERE machine_key = $5
      RETURNING *`,
      [public_ip, local_ip, os_info, ping_ms, machine_key, cpu_usage, ram_usage, ram_total, disk_usage, disk_total, reportedVersion, disks ? JSON.stringify(disks) : null, agent_logs || null, services ? JSON.stringify(services) : null, open_ports ? JSON.stringify(open_ports) : null, agent_config ? JSON.stringify(agent_config) : null, backup_status ? JSON.stringify(backup_status) : null, security_info ? JSON.stringify(security_info) : null, inventory ? JSON.stringify(inventory) : null]
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
      const latestVersion = verRow.rows.length > 0 ? verRow.rows[0].value : null;
      const updateUrl = urlRow.rows.length > 0 ? urlRow.rows[0].value : null;
      const hayVersionPropia = !!(latestVersion && updateUrl);
      if (hayVersionPropia && reportedVersion && isNewerVersion(reportedVersion, latestVersion)) {
        updateInfo = { version: latestVersion, url: updateUrl, origen: type };
      }
      // Fallback para el client: solo si NO tiene una version propia publicada.
      //
      // Antes la condicion era "no hay update que ofrecerle", que tambien se
      // cumple cuando el client YA ESTA AL DIA. Ahi caia al fallback y se le
      // ofrecia el binario del AGENTE, que es otro programa: lo bajaba, lo
      // instalaba, seguia reportando su propia version y volvia a pedirlo en el
      // siguiente latido. Un client al dia quedaba pidiendo el ejecutable del
      // agente para siempre.
      if (!hayVersionPropia && type === 'client') {
        const verRow2 = await pool.query("SELECT value FROM app_settings WHERE key = 'agent_version'");
        const urlRow2 = await pool.query("SELECT value FROM app_settings WHERE key = 'agent_url'");
        if (verRow2.rows.length > 0 && urlRow2.rows.length > 0 && verRow2.rows[0].value && urlRow2.rows[0].value && reportedVersion && isNewerVersion(reportedVersion, verRow2.rows[0].value)) {
          // Ojo: cae al binario del agente, asi que el hash tambien tiene que
          // ser el del agente.
          updateInfo = { version: verRow2.rows[0].value, url: urlRow2.rows[0].value, origen: 'agent' };
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
      // Firmamos cada comando para que el agente pueda verificar que salio de
      // este servidor antes de pasarselo a exec().
      pendingCommands = cmds.rows.map(c => ({
        ...c,
        sig: firmarParaMaquina(machine_key, 'cmd', String(c.id), c.command)
      }));
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

    // Freno de updates que no prenden.
    //
    // Un agente puede bajar el binario, "aplicarlo" y volver a arrancar con la
    // version de antes. Ahi vuelve a pedir el update en el siguiente latido y
    // se queda en un bucle bajando el ejecutable entero cada minuto. Paso de
    // verdad: 168 vueltas con la v1.0.0 y 163 con la v1.1.0 en una sola
    // maquina.
    //
    // Los agentes nuevos se frenan solos, pero ese arreglo viaja dentro del
    // binario que justamente no logran instalar. Por eso el freno tambien tiene
    // que estar aca: es el unico lado que se puede arreglar para los que ya
    // estan en la calle.
    const MAX_OFERTAS = 5;
    // La clave lleva el tipo de programa: el agente y el client comparten el
    // registro de la maquina, y sin esto los intentos fallidos de uno dejaban
    // sin actualizar al otro.
    const claveOferta = updateInfo ? `${agent_type || 'agent'}:${updateInfo.version}` : null;
    if (updateInfo) {
      const mismaOferta = updatedMachine.update_offer_version === claveOferta;
      const ofertas = mismaOferta ? (updatedMachine.update_offers || 0) : 0;
      if (ofertas >= MAX_OFERTAS) {
        // El aviso sale una sola vez, en el latido que cruza el limite. Repetirlo
        // en cada latido llenaria el log del server con el mismo renglon cada 30
        // segundos, que es justo el ruido que este freno viene a sacar.
        if (ofertas === MAX_OFERTAS) {
          console.warn(`[UPDATE] ${updatedMachine.machine_name}: se le ofrecio la v${updateInfo.version} ${ofertas} veces y sigue en v${reportedVersion}. Se deja de ofrecer; hay que actualizarla a mano.`);
          pool.query('UPDATE machines SET update_offers = $1 WHERE id = $2', [MAX_OFERTAS + 1, updatedMachine.id]).catch(() => {});
        }
        updateInfo = null;
      } else {
        pool.query(
          'UPDATE machines SET update_offers = $1, update_offer_version = $2 WHERE id = $3',
          [ofertas + 1, claveOferta, updatedMachine.id]
        ).catch(() => {});
      }
    } else if (updatedMachine.update_offer_version && updatedMachine.update_offer_version.startsWith(`${agent_type || 'agent'}:`)) {
      // Nada que ofrecerle a ESTE programa: o se actualizo, o el admin publico
      // otra cosa. No se toca el contador del otro, que puede estar frenado con
      // razon.
      pool.query(
        'UPDATE machines SET update_offers = 0, update_offer_version = NULL WHERE id = $1',
        [updatedMachine.id]
      ).catch(() => {});
    }

    // El update lleva hash del binario y firma; y no se ofrece por http, para
    // que nadie pueda sustituir el ejecutable en transito.
    if (updateInfo) {
      if (!/^https:\/\//i.test(updateInfo.url)) {
        console.warn('[SEGURIDAD] Update no ofrecido: la URL no es https ->', updateInfo.url);
        updateInfo = null;
      } else {
        const shaKey = updateInfo.origen === 'client' ? 'client_sha256' : 'agent_sha256';
        const shaRow = await pool.query('SELECT value FROM app_settings WHERE key = $1', [shaKey]).catch(() => null);
        updateInfo.sha256 = shaRow?.rows?.[0]?.value || null;
        if (!updateInfo.sha256) {
          console.warn(`[SEGURIDAD] Update v${updateInfo.version} sin ${shaKey} publicado: los agentes nuevos lo van a rechazar`);
        }
        delete updateInfo.origen; // detalle interno, no va al agente
        updateInfo.sig = firmarParaMaquina(machine_key, 'update', updateInfo.version, updateInfo.url, updateInfo.sha256 || '');
      }
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
// Inventario del parque, para armar el relevamiento de un cliente.
// Devuelve una fila por maquina con los datos ya aplanados.
function filasInventario(maquinas) {
  return maquinas.map(m => {
    const i = m.inventory || {};
    const disco = (i.discos || []);
    const solidos = disco.filter(d => (d.tipo || '').includes('SSD')).length;
    return {
      'Maquina': m.machine_name || '',
      'Hostname': i.hostname || '',
      'Usuario': i.usuario || '',
      'Dominio o grupo': i.en_dominio ? (i.dominio || '') : (i.grupo_trabajo || i.dominio || ''),
      'En dominio': i.en_dominio === true ? 'Si' : i.en_dominio === false ? 'No' : '',
      'Sistema operativo': [i.so, i.so_arch].filter(Boolean).join(' '),
      'Fabricante': i.fabricante || '',
      'Modelo': i.modelo || '',
      'Numero de serie': i.serie || '',
      'CPU': i.cpu || '',
      'Generacion CPU': i.cpu_generacion || '',
      'Nucleos': i.cpu_nucleos ?? '',
      'RAM (GB)': i.ram_gb ?? '',
      'Tipo de RAM': i.ram_tipo || '',
      'Slots usados': i.ram_slots_usados ?? '',
      'Slots totales': i.ram_slots_total ?? '',
      'Slots libres': i.ram_slots_libres ?? '',
      'Se puede ampliar RAM': i.ram_ampliable === true ? 'Si' : i.ram_ampliable === false ? 'No' : '',
      'RAM maxima (GB)': i.ram_max_gb ?? '',
      'Discos': disco.length,
      'Detalle de discos': disco.map(d => `${d.modelo || 's/d'} ${d.gb}GB ${d.tipo || ''}`.trim()).join(' / '),
      'Discos solidos': disco.length ? `${solidos} de ${disco.length}` : '',
      'Volumenes': (i.volumenes || []).map(v => `${v.letra} ${v.libre_gb}/${v.gb}GB`).join(' / '),
      'IP de internet': m.public_ip || '',
      'IP interna': i.ip_interna || '',
      'Gateway': i.gateway || '',
      'DNS': (i.dns || []).join(' '),
      'DHCP o fija': i.dhcp === true ? 'DHCP' : i.dhcp === false ? 'Fija' : '',
      'MAC': i.mac || '',
      'Placas de red activas': (i.placas || []).map(p => `${p.nombre} ${p.mac} ${p.ip || ''}`.trim()).join(' / '),
      'Proxy': i.proxy?.configurado ? (i.proxy.servidor || 'Si') : (i.proxy ? 'No' : ''),
      'Proxy del sistema': i.proxy?.winhttp || '',
      'Archivo hosts con entradas': i.hosts_tiene_entradas === true ? 'Si' : i.hosts_tiene_entradas === false ? 'No' : '',
      'Entradas del hosts': (i.hosts_entradas || []).join(' | '),
      'Inventario tomado': m.inventory_at ? new Date(m.inventory_at).toLocaleString('es-AR') : '',
      'Ultimo contacto': m.last_heartbeat ? new Date(m.last_heartbeat).toLocaleString('es-AR') : ''
    };
  });
}

// Excel en castellano abre el CSV con punto y coma, no con coma: con coma mete
// todo en una sola columna. El BOM es para que no rompa los acentos.
function aCsv(filas) {
  if (!filas.length) return '\uFEFF';
  const columnas = Object.keys(filas[0]);
  const escapar = v => {
    const t = String(v ?? '');
    return /[";\n\r]/.test(t) ? '"' + t.split('"').join('""') + '"' : t;
  };
  const lineas = [columnas.join(';')];
  for (const fila of filas) lineas.push(columnas.map(c => escapar(fila[c])).join(';'));
  return '\uFEFF' + lineas.join('\r\n');
}

app.get('/api/machines/inventory', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, machine_name, public_ip, last_heartbeat, is_online, inventory, inventory_at
       FROM machines WHERE user_id = $1 ORDER BY machine_name`, [req.user.id]);
    res.json(r.rows);
  } catch (e) {
    console.error('[INVENTARIO]', e.message);
    res.status(500).json({ error: 'No se pudo leer el inventario' });
  }
});

app.get('/api/machines/inventory.csv', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, machine_name, public_ip, last_heartbeat, inventory, inventory_at
       FROM machines WHERE user_id = $1 ORDER BY machine_name`, [req.user.id]);
    // Solo las que ya reportaron: una fila vacia por maquina sin agente nuevo
    // no aporta nada al relevamiento.
    const conDatos = r.rows.filter(m => m.inventory);
    const csv = aCsv(filasInventario(conDatos));
    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inventario-servereyes-${fecha}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('[INVENTARIO CSV]', e.message);
    res.status(500).json({ error: 'No se pudo generar el inventario' });
  }
});

app.get('/api/machines/sparklines', authenticateToken, async (req, res) => {
  try {
    // Las columnas de metrics_history son cpu_usage, ram_usage, ping_ms y
    // timestamp. La consulta pedia cpu, ram, ping y time, que no existen, asi
    // que este endpoint devolvia 500 siempre. Los alias mantienen la forma del
    // JSON que espera el frontend.
    const result = await pool.query(
      `SELECT m.id, (
        SELECT json_agg(json_build_object('cpu', h.cpu, 'ram', h.ram, 'ping', h.ping) ORDER BY h.time)
        FROM (SELECT cpu_usage AS cpu, ram_usage AS ram, ping_ms AS ping, timestamp AS time
              FROM metrics_history WHERE machine_id = m.id ORDER BY timestamp DESC LIMIT 12) h
      ) as points
      FROM machines m WHERE m.user_id = $1 AND m.is_online = true`,
      [req.user.id]
    );
    const data = {};
    for (const row of result.rows) {
      // json_agg ya los devuelve del mas viejo al mas nuevo, que es como se
      // dibuja una sparkline. El reverse() que habia aca los daba vuelta.
      if (row.points) data[row.id] = row.points;
    }
    res.json(data);
  } catch (error) {
    // Sin este log el error quedaba invisible: solo se veia un 500 en el
    // navegador y nada del lado del servidor.
    console.error('Error en sparklines:', error.message);
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

// Los certificados se miran cada 6 horas, pero la tarea corre cada 15 minutos
// y elige a los que les toca. Antes era un setInterval de 6 horas: como el
// primer disparo recien ocurre 6 horas despues de arrancar, cualquier deploy
// reiniciaba la cuenta y el chequeo no llegaba a correr nunca.
const SSL_CADA_HORAS = 6;
let sslChequeando = false;

async function revisarCertificados() {
  if (sslChequeando) return;
  sslChequeando = true;
  try {
    const monitors = await pool.query(
      `SELECT sm.*, u.id as uid FROM ssl_monitors sm JOIN users u ON sm.user_id = u.id
       WHERE sm.last_check IS NULL OR sm.last_check < NOW() - INTERVAL '${SSL_CADA_HORAS} hours'`
    );
    if (monitors.rows.length > 0) console.log(`[SSL] Revisando ${monitors.rows.length} certificado(s)`);
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
        avisarAExtras(mon.user_id, 'ssl', mon.id, `🔒 El certificado de ${mon.name || mon.hostname} vence en ${result.days_left} dias`,
          `<p style="font-size:15px;color:#333">El certificado SSL de <strong>${mon.hostname}</strong> vence en <strong>${result.days_left} dias</strong>.</p>
           <p style="color:#666">Fecha de vencimiento: ${result.expires_at.toLocaleDateString('es')}<br>Emisor: ${result.issuer || '?'}</p>
           <p style="color:#666">Conviene renovarlo antes para que los visitantes no vean la advertencia del navegador.</p>`);
        await pool.query('UPDATE ssl_monitors SET last_alerted_days = $1 WHERE id = $2', [matchedDay, mon.id]);
        console.log(`[SSL] Alerta: ${mon.hostname} vence en ${result.days_left} dias`);
      }
    }
  } catch (e) {
    console.error('Error SSL check:', e.message);
  } finally {
    sslChequeando = false;
  }
}

setInterval(revisarCertificados, 15 * 60 * 1000);
// Y una pasada al ratito de arrancar, para que un despliegue no deje los
// certificados sin datos hasta la proxima vuelta.
setTimeout(revisarCertificados, 45000);

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
    // Lo mismo para el client de escritorio: hasta ahora se podia publicar pero
    // no habia forma de ver desde el panel que version habia quedado.
    const clientFile = await pool.query('SELECT id, version, filename, file_size, changelog, uploaded_at FROM client_files ORDER BY uploaded_at DESC LIMIT 1').catch(() => ({ rows: [] }));
    const verClient = await pool.query("SELECT value FROM app_settings WHERE key = 'client_version'").catch(() => ({ rows: [] }));
    const shaAgent = await pool.query("SELECT value FROM app_settings WHERE key = 'agent_sha256'").catch(() => ({ rows: [] }));
    const shaClient = await pool.query("SELECT value FROM app_settings WHERE key = 'client_sha256'").catch(() => ({ rows: [] }));
    res.json({
      stats: { totalUsers, totalMachines, onlineMachines, offlineMachines: totalMachines - onlineMachines },
      users: users.rows,
      machines: machines.rows,
      latestAgent: agentFile.rows[0] || null,
      configuredVersion: ver.rows[0]?.value || null,
      latestClient: clientFile.rows[0] || null,
      configuredClientVersion: verClient.rows[0]?.value || null,
      agentSha256: shaAgent.rows[0]?.value || null,
      clientSha256: shaClient.rows[0]?.value || null
    });
  } catch (error) {
    console.error('Error en admin overview:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Subir nuevo agente (base64)
// Rechazar publicar un binario identico al que ya esta publicado, pero con otro
// numero de version.
//
// Esto existe por el bucle de updates que nos costo una noche: se subio el
// ejecutable viejo declarando una version nueva. El server lo sirvio fielmente,
// los agentes lo instalaron bien y siguieron reportando su version real, asi que
// el server volvia a ofrecerles la actualizacion en cada latido, para siempre.
//
// Se compara por hash y no leyendo la version de adentro del ejecutable: pkg
// empaqueta el codigo como bytecode, y un binario de 37 MB con Node adentro trae
// cadenas de version de todas sus dependencias, asi que buscar "1.3.4" ahi da
// falsos positivos en cualquier direccion.
async function mismoBinarioYaPublicado(sha256, version, claveSha, claveVersion) {
  const shaRow = await pool.query('SELECT value FROM app_settings WHERE key = $1', [claveSha]).catch(() => null);
  const verRow = await pool.query('SELECT value FROM app_settings WHERE key = $1', [claveVersion]).catch(() => null);
  const shaPublicado = shaRow?.rows?.[0]?.value;
  const versionPublicada = verRow?.rows?.[0]?.value;
  if (!shaPublicado || shaPublicado !== sha256) return null;
  if (versionPublicada === version) return null; // republicar lo mismo es inofensivo
  return `Este ejecutable es exactamente el mismo que ya esta publicado como version ${versionPublicada}, `
    + `pero lo estas subiendo como ${version}. Si se publica, los agentes lo van a instalar y van a seguir `
    + `reportando ${versionPublicada}, asi que el servidor les va a ofrecer la actualizacion una y otra vez. `
    + `Fijate de subir el ejecutable recien compilado (el de la carpeta dist).`;
}

app.post('/api/admin/agent/upload', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { version, filename, file_base64, changelog } = req.body;
    if (!version || !file_base64) return res.status(400).json({ error: 'version y file_base64 requeridos' });
    const buffer = Buffer.from(file_base64, 'base64');
    if (buffer.length < 1024 * 100) return res.status(400).json({ error: 'Archivo muy chico, parece invalido' });

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const repetido = await mismoBinarioYaPublicado(sha256, version, 'agent_sha256', 'agent_version');
    if (repetido) {
      console.warn('[UPLOAD] Publicacion de agente rechazada:', repetido);
      return res.status(400).json({ error: repetido });
    }

    await pool.query(
      'INSERT INTO agent_files (version, filename, file_data, file_size, changelog) VALUES ($1, $2, $3, $4, $5)',
      [version, filename || 'ServerEyes-Agent.exe', buffer, buffer.length, changelog || '']
    );

    // Actualizar version configurada y URL de descarga automaticamente
    // Antes salia del host con el que entro el admin al panel: si subia desde
    // la URL de Railway, todos los agentes quedaban apuntando ahi.
    const downloadUrl = `${urlPublica()}/api/agent/download`;
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('agent_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [version]);
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('agent_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [downloadUrl]);
    // Hash del binario que acabamos de guardar: el agente lo verifica antes de
    // reemplazar su propio ejecutable.
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('agent_sha256', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [sha256]);

    // Publicar es la senal de "algo cambio, volve a intentar": se reinicia el
    // freno de todas las maquinas. Sin esto, una maquina que se freno con el
    // binario anterior quedaria sin recibir el nuevo, aunque el problema ya
    // este resuelto.
    await pool.query('UPDATE machines SET update_offers = 0, update_offer_version = NULL WHERE update_offer_version IS NOT NULL').catch(() => {});

    res.json({ message: 'Agente subido', version, size: buffer.length, downloadUrl, sha256 });
  } catch (error) {
    console.error('Error subiendo agente:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Descargar agente (publico, sin auth - los agentes lo descargan)
// ── BINARIO DEL CLIENT DE ESCRITORIO ──
//
// El client pesa bastante mas que el agente (unos 90 MB contra 37), y en
// base64 se va a ~120 MB: no entra en el limite de express.json. Por eso este
// va como multipart, que ademas evita el 33% de sobrecarga del base64.
const subirBinario = require('multer')({
  storage: require('multer').memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024, files: 1 }
});
const VERSIONES_A_CONSERVAR = 3;

app.post('/api/admin/client/upload', authenticateToken, requireAdmin, subirBinario.single('file'), async (req, res) => {
  try {
    const { version, changelog } = req.body;
    if (!version) return res.status(400).json({ error: 'version requerida' });
    if (!req.file) return res.status(400).json({ error: 'archivo requerido (campo "file")' });
    const buffer = req.file.buffer;
    if (buffer.length < 1024 * 1024) return res.status(400).json({ error: 'Archivo muy chico, parece invalido' });

    const shaClient = crypto.createHash('sha256').update(buffer).digest('hex');
    const repetidoClient = await mismoBinarioYaPublicado(shaClient, version, 'client_sha256', 'client_version');
    if (repetidoClient) {
      console.warn('[UPLOAD] Publicacion de client rechazada:', repetidoClient);
      return res.status(400).json({ error: repetidoClient });
    }

    await pool.query(
      'INSERT INTO client_files (version, filename, file_data, file_size, changelog) VALUES ($1, $2, $3, $4, $5)',
      [version, req.file.originalname || 'ServerEyes-Portable.exe', buffer, buffer.length, changelog || '']
    );

    const downloadUrl = `${urlPublica()}/api/client/download`;
    // Reusa el hash ya calculado: el client pesa ~90 MB y no vale la pena
    // recorrerlo dos veces.
    const sha256 = shaClient;
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('client_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [version]);
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('client_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [downloadUrl]);
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('client_sha256', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [sha256]);

    // Publicar es la senal de "algo cambio, volve a intentar": se reinicia el
    // freno de todas las maquinas. Sin esto, una maquina que se freno con el
    // binario anterior quedaria sin recibir el nuevo, aunque el problema ya
    // este resuelto.
    await pool.query('UPDATE machines SET update_offers = 0, update_offer_version = NULL WHERE update_offer_version IS NOT NULL').catch(() => {});

    // Cada version ocupa ~90 MB en la base: no guardamos el historial entero.
    const podadas = await pool.query(
      `DELETE FROM client_files WHERE id NOT IN (
         SELECT id FROM client_files ORDER BY uploaded_at DESC LIMIT ${VERSIONES_A_CONSERVAR}
       )`
    );
    if (podadas.rowCount > 0) console.log(`[CLIENT] ${podadas.rowCount} version(es) vieja(s) eliminada(s)`);

    logAudit(req.user.id, 'upload_client', 'client_files', null, `${version} (${buffer.length} bytes)`, req.ip);
    console.log(`[CLIENT] Version ${version} publicada, sha256=${sha256}`);
    res.json({ message: 'Client subido', version, size: buffer.length, downloadUrl, sha256 });
  } catch (error) {
    console.error('Error subiendo client:', error.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/client/download', async (req, res) => {
  try {
    const result = await pool.query('SELECT filename, file_data FROM client_files ORDER BY uploaded_at DESC LIMIT 1');
    if (result.rows.length === 0) return res.status(404).json({ error: 'No hay client disponible' });
    const { filename, file_data } = result.rows[0];
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(file_data);
  } catch (error) {
    console.error('Error descargando client:', error.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

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
// Volver a publicar una version que ya esta en el historial.
//
// No sube nada: apunta la version publicada a un binario que ya esta guardado y
// recalcula su hash. Sirve para deshacer una publicacion equivocada sin tener
// que recompilar, que era la unica salida.
async function republicar(req, res, tipo) {
  const tabla = tipo === 'client' ? 'client_files' : 'agent_files';
  const rutaDescarga = tipo === 'client' ? '/api/client/download' : '/api/agent/download';
  const claves = tipo === 'client'
    ? { version: 'client_version', url: 'client_url', sha: 'client_sha256' }
    : { version: 'agent_version', url: 'agent_url', sha: 'agent_sha256' };
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id invalido' });

    const r = await pool.query(`SELECT id, version, file_data FROM ${tabla} WHERE id = $1`, [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Esa version ya no esta guardada' });
    const fila = r.rows[0];

    // Se reapunta al binario mas nuevo con ese numero de version: si se subio
    // varias veces el mismo numero, el que vale es el ultimo.
    const ultima = await pool.query(
      `SELECT id FROM ${tabla} WHERE version = $1 ORDER BY uploaded_at DESC LIMIT 1`, [fila.version]);
    const elegido = ultima.rows[0]?.id === fila.id
      ? fila
      : (await pool.query(`SELECT id, version, file_data FROM ${tabla} WHERE id = $1`, [ultima.rows[0].id])).rows[0];

    const sha256 = crypto.createHash('sha256').update(elegido.file_data).digest('hex');
    const downloadUrl = `${urlPublica()}${rutaDescarga}`;
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('${claves.version}', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [elegido.version]);
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('${claves.url}', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [downloadUrl]);
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('${claves.sha}', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [sha256]);

    // Igual que al publicar: cambio el binario, todas las maquinas tienen otra
    // oportunidad aunque se hubieran frenado con el anterior.
    await pool.query('UPDATE machines SET update_offers = 0, update_offer_version = NULL WHERE update_offer_version IS NOT NULL').catch(() => {});

    console.log(`[UPLOAD] ${tipo} vuelto a la version ${elegido.version} (sha ${sha256.slice(0, 12)})`);
    res.json({ message: `Publicada la version ${elegido.version}`, version: elegido.version, sha256, downloadUrl });
  } catch (error) {
    console.error(`Error republicando ${tipo}:`, error.message);
    res.status(500).json({ error: 'No se pudo volver a esa version' });
  }
}

app.post('/api/admin/agent/republicar/:id', authenticateToken, requireAdmin, (req, res) => republicar(req, res, 'agent'));
app.post('/api/admin/client/republicar/:id', authenticateToken, requireAdmin, (req, res) => republicar(req, res, 'client'));

app.get('/api/admin/agent/history', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, version, filename, file_size, changelog, uploaded_at FROM agent_files ORDER BY uploaded_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── SMTP GLOBAL (solo admin) ──
// Configurado una vez, sirve para todos los usuarios que no tengan el suyo.

app.get('/api/admin/smtp', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const c = await configSmtpGlobal();
    res.json({
      smtp_host: c.host || '',
      smtp_port: c.port || '587',
      smtp_secure: c.secure || 'tls',
      smtp_user: c.user || '',
      smtp_from: c.from || '',
      // La clave nunca se devuelve: solo si hay una guardada.
      tiene_pass: !!c.pass,
      // Para que se vea si esta cayendo al respaldo del entorno.
      desde_entorno: !c.host && !!process.env.SMTP_HOST
    });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/admin/smtp', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from } = req.body;
    const guardar = async (clave, valor) => {
      await pool.query(
        "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
        [clave, valor == null ? '' : String(valor)]
      );
    };
    await guardar('smtp_host', smtp_host);
    await guardar('smtp_port', smtp_port || '587');
    await guardar('smtp_secure', smtp_secure || 'tls');
    await guardar('smtp_user', smtp_user);
    await guardar('smtp_from', smtp_from);
    // Vacia = no tocar la que ya estaba, para no obligar a reescribirla.
    if (smtp_pass) await guardar('smtp_pass', cifrarSecreto(smtp_pass));

    invalidarTransporteGlobal();
    logAudit(req.user.id, 'config_smtp_global', 'app_settings', null, `${smtp_user}@${smtp_host}`, req.ip);
    res.json({ message: 'SMTP global guardado' });
  } catch (error) {
    console.error('Error guardando SMTP global:', error.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/admin/smtp/test', authenticateToken, requireAdmin, async (req, res) => {
  try {
    invalidarTransporteGlobal();
    const t = await transporteGlobal();
    if (!t) return res.status(400).json({ error: 'No hay SMTP global configurado' });
    const destino = req.body?.to || req.user.email;
    await sendEmail(destino, 'Prueba de SMTP global',
      `<p style="color:#333">Si estas leyendo esto, el SMTP global de ServerEyes funciona.</p>
       <p style="color:#666">Este es el remitente que van a ver todos los usuarios que no tengan un SMTP propio configurado.</p>`);
    res.json({ message: `Enviado a ${destino}`, remitente: _remitenteGlobal });
  } catch (error) {
    res.status(500).json({ error: 'Error: ' + error.message });
  }
});

// Espejo del historial del agente. Del client se conservan las ultimas 3
// versiones (cada una pesa ~89 MB), asi que la lista es corta por diseño.
app.get('/api/admin/client/history', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, version, filename, file_size, changelog, uploaded_at FROM client_files ORDER BY uploaded_at DESC LIMIT 20');
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

// Configurar version del agente.
// Requiere admin: esta URL la descarga y ejecuta CADA agente instalado, asi que
// con solo authenticateToken cualquier usuario registrado podia apuntar el
// auto-update de todo el parque a un binario propio.
app.post('/api/agent/version', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { version, url, sha256, tipo } = req.body;
    if (!version || !url) return res.status(400).json({ error: 'version y url requeridos' });
    if (!/^https:\/\//i.test(url)) return res.status(400).json({ error: 'La URL de update debe ser https' });
    if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) return res.status(400).json({ error: 'sha256 invalido' });
    if (tipo && tipo !== 'agent' && tipo !== 'client') return res.status(400).json({ error: "tipo debe ser 'agent' o 'client'" });
    // El client de escritorio usa sus propias claves. Antes solo se leian: no
    // habia forma de publicar una version del client sin tocar la base a mano.
    const prefijo = tipo === 'client' ? 'client' : 'agent';
    await pool.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [`${prefijo}_version`, version]);
    await pool.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [`${prefijo}_url`, url]);
    if (sha256) await pool.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [`${prefijo}_sha256`, sha256.toLowerCase()]);
    logAudit(req.user.id, 'set_agent_version', 'app_settings', null, `${prefijo} ${version} ${url}`, req.ip);
    res.json({ message: 'Version actualizada', tipo: prefijo, version, url, sha256: sha256 || null });
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
      await pool.query('UPDATE users SET smtp_pass = $1 WHERE id = $2', [cifrarSecreto(smtp_pass), req.user.id]);
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
    if (!await transporteGlobal()) return res.status(400).json({ error: 'Email no configurado. Cargalo en Admin > Sistema > Email del sistema.' });
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
    const result = await pool.query(`SELECT sm.*,
       (SELECT json_agg(json_build_object('email', mr.email, 'estado', mr.estado) ORDER BY mr.email)
        FROM monitor_recipients mr WHERE mr.tipo = 'ssl' AND mr.monitor_id = sm.id) as destinatarios
       FROM ssl_monitors sm WHERE sm.user_id = $1 ORDER BY sm.hostname`, [req.user.id]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/ssl-monitors', authenticateToken, async (req, res) => {
  try {
    const { hostname, name, alert_days, notify_emails } = req.body;
    if (!hostname) return res.status(400).json({ error: 'hostname requerido' });
    const h = hostname.replace(/^https?:\/\//, '').split('/')[0];
    const days = alert_days || [30, 14, 7, 1];
    const correos = notify_emails === undefined ? [] : normalizarCorreos(notify_emails);
    if (correos === null) return res.status(400).json({ error: 'notify_emails debe ser una lista' });
    if (correos.error) return res.status(400).json({ error: correos.error });
    const result = await pool.query(
      'INSERT INTO ssl_monitors (user_id, hostname, name, alert_days, notify_emails) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, h, name || h, JSON.stringify(days), JSON.stringify(correos)]
    );
    const duenio = await traerDuenio(req.user.id);
    if (duenio) {
      await sincronizarDestinatarios('ssl', result.rows[0].id, correos, duenio,
        name || h, `Que el certificado de seguridad de ${h} no venza sin aviso.`);
    }
    res.status(201).json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/api/ssl-monitors/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM ssl_monitors WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    await borrarDestinatarios('ssl', req.params.id);
    res.json({ message: 'Eliminado' });
  } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.put('/api/ssl-monitors/:id', authenticateToken, async (req, res) => {
  try {
    const { alert_days, name, hostname, notify_emails } = req.body;
    const fields = [];
    const vals = [];
    let idx = 1;
    if (alert_days !== undefined) { fields.push(`alert_days = ${idx++}`); vals.push(JSON.stringify(alert_days)); }
    if (name !== undefined) { fields.push(`name = ${idx++}`); vals.push(name); }
    if (hostname !== undefined) {
      // Aceptamos que peguen una URL entera y nos quedamos con el host.
      let limpio = String(hostname).trim().replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0];
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(limpio)) return res.status(400).json({ error: 'Hostname invalido' });
      fields.push(`hostname = ${idx++}`); vals.push(limpio.toLowerCase());
      // Lo chequeado corresponde al host anterior: se limpia para que el
      // proximo ciclo lo vuelva a mirar en vez de mostrar datos de otro dominio.
      fields.push('last_check = NULL', 'last_days_left = NULL', 'last_issuer = NULL', 'last_expiry = NULL', 'last_status = NULL', 'last_alerted_days = NULL');
    }
    if (notify_emails !== undefined) {
      const correos = normalizarCorreos(notify_emails);
      if (correos === null) return res.status(400).json({ error: 'notify_emails debe ser una lista' });
      if (correos.error) return res.status(400).json({ error: correos.error });
      fields.push(`notify_emails = ${idx++}`); vals.push(JSON.stringify(correos));
    }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
    vals.push(req.params.id, req.user.id);
    await pool.query(`UPDATE ssl_monitors SET ${fields.join(', ')} WHERE id = ${idx++} AND user_id = ${idx}`, vals);
    if (notify_emails !== undefined) {
      const m = await pool.query('SELECT id, hostname, name FROM ssl_monitors WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      const duenio = await traerDuenio(req.user.id);
      if (m.rows[0] && duenio) {
        await sincronizarDestinatarios('ssl', m.rows[0].id, normalizarCorreos(notify_emails), duenio,
          m.rows[0].name || m.rows[0].hostname, `Que el certificado de seguridad de ${m.rows[0].hostname} no venza sin aviso.`);
      }
    }
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

app.get('/api/status', async (req, res) => {
  // transporteGlobal() cachea, asi que esto no rearma nada en cada consulta.
  let email = 'disabled';
  try { email = (await transporteGlobal()) ? 'active' : 'disabled'; } catch (e) {}
  res.json({
    status: 'ServerEyes running',
    timestamp: new Date().toISOString(),
    firebase: firebaseAdmin ? 'active' : 'disabled',
    email,
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
    const own = await pool.query(`SELECT um.*, false as is_shared${SUB_DESTINATARIOS_URL}
       FROM url_monitors um WHERE um.user_id = $1 ORDER BY um.created_at DESC`, [req.user.id]);
    const shared = await pool.query(
      `SELECT um.*, true as is_shared, u.email as owner_email, u.nombre as owner_name${SUB_DESTINATARIOS_URL}
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
    const { url, name, method, expected_status, timeout_ms, interval_seconds, notify_emails } = req.body;
    if (!url) return res.status(400).json({ error: 'url requerido' });
    const correos = notify_emails === undefined ? [] : normalizarCorreos(notify_emails);
    if (correos && correos.error) return res.status(400).json({ error: correos.error });
    if (correos === null) return res.status(400).json({ error: 'notify_emails debe ser una lista' });
    const result = await pool.query(
      'INSERT INTO url_monitors (user_id, url, name, method, expected_status, timeout_ms, interval_seconds, notify_emails) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [req.user.id, url, name || url, method || 'GET', expected_status || 200, timeout_ms || 10000, interval_seconds || 300, JSON.stringify(correos)]
    );
    const duenio = await traerDuenio(req.user.id);
    if (duenio) {
      await sincronizarDestinatarios('url', result.rows[0].id, correos, duenio,
        name || url, `Que el sitio ${url} responda correctamente, con un chequeo cada pocos minutos.`);
    }
    logAudit(req.user.id, 'create_url_monitor', 'url_monitor', result.rows[0].id, url, req.ip);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.put('/api/url-monitors/:id', authenticateToken, async (req, res) => {
  try {
    const { url, name, method, expected_status, timeout_ms, interval_seconds, is_active, notify_emails } = req.body;
    let correos = null;
    if (notify_emails !== undefined) {
      correos = normalizarCorreos(notify_emails);
      if (correos === null) return res.status(400).json({ error: 'notify_emails debe ser una lista' });
      if (correos.error) return res.status(400).json({ error: correos.error });
    }
    const result = await pool.query(
      `UPDATE url_monitors SET url=COALESCE($1,url), name=COALESCE($2,name), method=COALESCE($3,method),
       expected_status=COALESCE($4,expected_status), timeout_ms=COALESCE($5,timeout_ms),
       interval_seconds=COALESCE($6,interval_seconds), is_active=COALESCE($7,is_active),
       notify_emails=COALESCE($10,notify_emails)
       WHERE id=$8 AND user_id=$9 RETURNING *`,
      [url, name, method, expected_status, timeout_ms, interval_seconds, is_active, req.params.id, req.user.id,
       correos === null ? null : JSON.stringify(correos)]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Monitor no encontrado' });
    if (correos !== null) {
      const duenio = await traerDuenio(req.user.id);
      const m = result.rows[0];
      if (duenio) {
        await sincronizarDestinatarios('url', m.id, correos, duenio,
          m.name || m.url, `Que el sitio ${m.url} responda correctamente, con un chequeo cada pocos minutos.`);
      }
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.delete('/api/url-monitors/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM url_monitors WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    await borrarDestinatarios('url', req.params.id);
    res.json({ message: 'Monitor eliminado' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Historial de chequeos de una URL (dueno o tecnico con la URL compartida).
// ?limit=N (max 1000) y ?only_failures=true para ver solo caidas y fallos transitorios.
app.get('/api/url-monitors/:id/history', authenticateToken, async (req, res) => {
  try {
    const urlId = parseInt(req.params.id, 10);
    if (!urlId) return res.status(400).json({ error: 'id invalido' });
    const acceso = await pool.query(
      `SELECT um.id FROM url_monitors um
       LEFT JOIN url_shares us ON us.url_id = um.id AND us.user_id = $2
       WHERE um.id = $1 AND (um.user_id = $2 OR us.user_id IS NOT NULL)`,
      [urlId, req.user.id]
    );
    if (acceso.rows.length === 0) return res.status(404).json({ error: 'Monitor no encontrado' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const filtro = req.query.only_failures === 'true' ? 'AND (is_up = false OR attempts > 1)' : '';
    const result = await pool.query(
      `SELECT checked_at, is_up, status, response_ms, error, attempts, notified
       FROM url_check_history WHERE url_id = $1 ${filtro}
       ORDER BY checked_at DESC LIMIT $2`,
      [urlId, limit]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// URL monitor checker (runs every 60 seconds)
// Un solo fallo NO dispara alarma: se reintenta URL_CHECK_RETRIES veces antes
// de declarar la URL caida, para filtrar cortes transitorios (resets TCP,
// 5xx momentaneos de CDN, hipos de DNS).
const URL_CHECK_RETRIES = 3;
const URL_CHECK_RETRY_DELAY_MS = 15000;
const URL_CHECK_CONCURRENCY = 10;
// UA de navegador real: los WAF/bot-management (Cloudflare y similares) suelen
// responder 403 o challenge a User-Agents desconocidos, lo que se contaba como
// caida aunque el sitio estuviera perfecto. X-Monitor permite identificar
// nuestro trafico en los logs del sitio sin activar esas reglas.
const URL_MONITOR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function followRedirects(urlStr, method, timeoutMs, maxRedirects) {
  const https = require('https');
  const http = require('http');
  const totalTimeout = timeoutMs || 10000;
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let settled = false;
    let current = null;
    // Un unico timer para toda la cadena de redirecciones. Antes se creaba uno
    // por salto sin limpiar el anterior, y el timer viejo rechazaba la promesa
    // aunque la respuesta hubiera llegado bien.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (current) current.destroy();
      reject(new Error('Timeout'));
    }, totalTimeout);
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(val);
    };
    function doRequest(url) {
      let urlObj;
      try { urlObj = new URL(url); } catch (e) { return finish(new Error('URL invalida: ' + url)); }
      const client = urlObj.protocol === 'https:' ? https : http;
      const opts = {
        method: method || 'GET',
        timeout: totalTimeout,
        headers: {
          'User-Agent': URL_MONITOR_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
          'X-Monitor': 'ServerEyes/1.0'
        },
        // Un certificado vencido o con cadena incompleta no es "sitio caido":
        // eso ya lo vigila ssl_monitors con su propia alerta.
        // (antes decia rejectAuthorized, que es un typo y no hacia nada)
        rejectUnauthorized: false,
        // Happy Eyeballs como un navegador: si el AAAA no responde, cae a IPv4
        // en vez de fallar el chequeo.
        autoSelectFamily: true
      };
      const r = client.request(urlObj, opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          // Un loop de redirecciones deja la pagina inservible para el visitante:
          // es una caida, no un 302 sano. Antes se devolvia el 302 como "arriba".
          if (redirects >= (maxRedirects || 5)) return finish(new Error('Demasiadas redirecciones (' + redirects + ')'));
          redirects++;
          let next = null;
          try { next = new URL(res.headers.location, urlObj).href; } catch (e) { next = null; }
          if (!next) return finish(new Error('Redirect invalido: ' + res.headers.location));
          doRequest(next);
          return;
        }
        res.resume(); // drenamos sin acumular el body en memoria
        res.on('end', () => finish(null, { status: res.statusCode, redirects }));
      });
      current = r;
      r.on('error', (e) => finish(e));
      r.on('timeout', () => r.destroy(new Error('Timeout')));
      r.end();
    }
    doRequest(urlStr);
  });
}

// Un intento suelto contra la URL. Nunca lanza: devuelve el resultado.
async function probeUrl(mon) {
  const startTime = Date.now();
  try {
    const result = await followRedirects(mon.url, mon.method, mon.timeout_ms || 10000, 5);
    const isUp = result.status >= 200 && result.status < 400;
    return {
      isUp,
      status: result.status,
      ms: Date.now() - startTime,
      error: isUp ? null : `HTTP ${result.status}`
    };
  } catch (err) {
    return { isUp: false, status: null, ms: Date.now() - startTime, error: err.message || 'Error desconocido' };
  }
}

async function checkUrlMonitor(mon) {
  let probe = await probeUrl(mon);
  let attempts = 1;
  let lastError = probe.error;
  while (!probe.isUp && attempts < URL_CHECK_RETRIES) {
    await sleep(URL_CHECK_RETRY_DELAY_MS);
    probe = await probeUrl(mon);
    attempts++;
    if (probe.error) lastError = probe.error;
  }

  const isUp = probe.isUp;
  const wasUp = mon.is_up;
  // Notificamos solo cuando cambia el estado y ya se confirmo con reintentos.
  const notify = mon.notify_down && wasUp !== isUp;

  await pool.query(
    `UPDATE url_monitors SET last_status=$1, last_response_ms=$2, last_check=NOW(), last_error=$3,
     is_up=$4, down_since=CASE WHEN $4=true THEN NULL ELSE COALESCE(down_since, NOW()) END
     WHERE id=$5`,
    [probe.status, probe.ms, isUp ? null : lastError, isUp, mon.id]
  );

  // Historial: queda registro aunque la URL se recupere. Guardamos tambien los
  // fallos transitorios (isUp=true con attempts>1) para poder hacer post-mortem.
  await pool.query(
    `INSERT INTO url_check_history (url_id, is_up, status, response_ms, error, attempts, notified)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [mon.id, isUp, probe.status, probe.ms, lastError, attempts, notify]
  ).catch(e => console.error('[URL-MONITOR] No se pudo guardar historial:', e.message));

  if (notify && isUp) {
    sendPush(mon.owner_id, '✅ URL Recuperada', `${mon.name || mon.url} esta respondiendo (${probe.ms}ms)`, { type: 'url_up' });
    avisarAExtras(mon.owner_id, 'url', mon.id, `✅ ${mon.name || mon.url} volvio a funcionar`,
      `<p style="font-size:15px;color:#333"><strong>${mon.name || mon.url}</strong> volvio a responder normalmente.</p>
       <p style="color:#666">Tiempo de respuesta: ${probe.ms}ms<br>URL: ${mon.url}</p>`);
  } else if (notify && !isUp) {
    sendPush(mon.owner_id, '🚨 URL Caida', `${mon.name || mon.url}: ${lastError} (${attempts} intentos)`, { type: 'url_down' });
    avisarAExtras(mon.owner_id, 'url', mon.id, `🚨 ${mon.name || mon.url} no responde`,
      `<p style="font-size:15px;color:#333"><strong>${mon.name || mon.url}</strong> no esta respondiendo.</p>
       <p style="color:#666">Detalle: ${lastError}<br>URL: ${mon.url}<br>Se reintento ${attempts} veces antes de avisar.</p>`);
  }
  if (!isUp) {
    console.log(`[URL-MONITOR] CAIDA ${mon.url} -> ${lastError} tras ${attempts} intentos`);
  } else if (attempts > 1) {
    console.log(`[URL-MONITOR] Fallo transitorio en ${mon.url} (${lastError}), recupero en el intento ${attempts}`);
  }
}

let urlCheckRunning = false;
setInterval(async () => {
  if (urlCheckRunning) return; // evitamos solapar ciclos: con reintentos un ciclo puede pasar los 60s
  urlCheckRunning = true;
  try {
    const monitors = await pool.query(
      `SELECT um.*, u.id as owner_id FROM url_monitors um
       JOIN users u ON um.user_id = u.id
       WHERE um.is_active = true
       AND (um.last_check IS NULL OR um.last_check < NOW() - (um.interval_seconds || ' seconds')::INTERVAL)`
    );
    // En tandas: los reintentos hacen que un monitor caido tarde ~30s, y en
    // serie eso retrasaba el chequeo de todos los demas.
    for (let i = 0; i < monitors.rows.length; i += URL_CHECK_CONCURRENCY) {
      const tanda = monitors.rows.slice(i, i + URL_CHECK_CONCURRENCY);
      await Promise.all(tanda.map(mon =>
        checkUrlMonitor(mon).catch(e => console.error(`[URL-MONITOR] Error en ${mon.url}:`, e.message))
      ));
    }
  } catch (err) {
    console.error('[URL-MONITOR] Error:', err.message);
  } finally {
    urlCheckRunning = false;
  }
}, 60000);

// Purga del historial de chequeos (retencion 30 dias).
//
// Estaba en un setInterval de 24 horas: desplegando a diario no llegaba a
// correr nunca y la tabla crecia sin techo. Borrar por fecha es idempotente,
// asi que correrlo cada hora no cuesta nada y no depende de que el proceso
// sobreviva un dia entero.
async function purgarHistorialUrls() {
  try {
    const r = await pool.query(`DELETE FROM url_check_history WHERE checked_at < NOW() - INTERVAL '30 days'`);
    if (r.rowCount > 0) console.log(`[URL-MONITOR] Historial purgado: ${r.rowCount} registros`);
  } catch (err) {
    console.error('[URL-MONITOR] Error purgando historial:', err.message);
  }
}

setInterval(purgarHistorialUrls, 60 * 60 * 1000);
setTimeout(purgarHistorialUrls, 120000);

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

// Reporte semanal: lunes a la mañana (11 UTC = 8 en Argentina).
//
// Antes preguntaba "son exactamente las 11 del lunes?" una vez por hora. Si el
// deploy caia en esa hora, esa semana no salia y nadie se enteraba, porque no
// quedaba registro de si se habia mandado. Ahora se guarda cuando salio cada
// uno y la condicion mira eso, no el reloj:
//   - nunca se le mando: sale
//   - es lunes despues de las 11 y el ultimo tiene mas de 3 dias: sale
//   - pasaron mas de 8 dias: sale igual, aunque no sea lunes
// La ultima linea es la que hace que un fin de semana caido no cueste la
// semana entera.
let reporteCorriendo = false;

async function mandarReportesSemanales() {
  if (reporteCorriendo) return;
  reporteCorriendo = true;
  try {
    const ahora = new Date();
    const esLunesTemprano = ahora.getUTCDay() === 1 && ahora.getUTCHours() >= 11;
    const users = await pool.query(
      `SELECT id FROM users
       WHERE email_notifications = true
         AND (last_report_at IS NULL
              OR (${esLunesTemprano ? 'true' : 'false'} AND last_report_at < NOW() - INTERVAL '3 days')
              OR last_report_at < NOW() - INTERVAL '8 days')`
    );
    if (users.rows.length === 0) return;
    console.log(`[REPORT] Enviando reporte semanal a ${users.rows.length} usuario(s)`);
    for (const u of users.rows) {
      // Se marca antes de mandar: si el envio falla, no queremos reintentarlo
      // cada 15 minutos durante una semana.
      await pool.query('UPDATE users SET last_report_at = NOW() WHERE id = $1', [u.id]);
      await generateWeeklyReport(u.id);
    }
  } catch (e) {
    console.error('[REPORT] Error:', e.message);
  } finally {
    reporteCorriendo = false;
  }
}

setInterval(mandarReportesSemanales, 15 * 60 * 1000);
setTimeout(mandarReportesSemanales, 90000);

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

// ── ASIGNACION MASIVA ──
// Elegir una direccion y tildar en que monitores recibe, en vez de entrar a
// cada monitor por separado.

app.get('/api/notificaciones/destinatarios', authenticateToken, async (req, res) => {
  try {
    const urls = await pool.query('SELECT id, name, url FROM url_monitors WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    const ssls = await pool.query('SELECT id, name, hostname FROM ssl_monitors WHERE user_id = $1 ORDER BY hostname', [req.user.id]);
    const dest = await pool.query(
      'SELECT email, tipo, monitor_id, estado FROM monitor_recipients WHERE agregado_por = $1 ORDER BY email',
      [req.user.id]
    );
    res.json({
      urls: urls.rows.map(u => ({ id: u.id, nombre: u.name || u.url, detalle: u.url })),
      ssls: ssls.rows.map(m => ({ id: m.id, nombre: m.name || m.hostname, detalle: m.hostname })),
      destinatarios: dest.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/notificaciones/asignar', authenticateToken, async (req, res) => {
  try {
    const { email, urls, ssls } = req.body;
    const limpio = normalizarCorreos([email]);
    if (limpio === null || limpio.error || limpio.length === 0) {
      return res.status(400).json({ error: limpio && limpio.error ? limpio.error : 'Correo invalido' });
    }
    const correo = limpio[0];
    const pedidosUrl = Array.isArray(urls) ? urls.map(Number).filter(Boolean) : [];
    const pedidosSsl = Array.isArray(ssls) ? ssls.map(Number).filter(Boolean) : [];

    // Solo monitores propios: los ids llegan del cliente.
    const misUrls = (await pool.query('SELECT id, name, url FROM url_monitors WHERE user_id = $1 AND id = ANY($2)', [req.user.id, pedidosUrl])).rows;
    const misSsls = (await pool.query('SELECT id, name, hostname FROM ssl_monitors WHERE user_id = $1 AND id = ANY($2)', [req.user.id, pedidosSsl])).rows;

    const actuales = (await pool.query(
      'SELECT tipo, monitor_id FROM monitor_recipients WHERE email = $1 AND agregado_por = $2', [correo, req.user.id]
    )).rows;
    const clave = (t, id) => `${t}:${id}`;
    const yaEstaba = new Set(actuales.map(a => clave(a.tipo, a.monitor_id)));
    const deseados = new Set([...misUrls.map(u => clave('url', u.id)), ...misSsls.map(m => clave('ssl', m.id))]);

    // Sacar los destildados
    let quitados = 0;
    for (const a of actuales) {
      if (!deseados.has(clave(a.tipo, a.monitor_id))) {
        await pool.query('DELETE FROM monitor_recipients WHERE email = $1 AND agregado_por = $2 AND tipo = $3 AND monitor_id = $4',
          [correo, req.user.id, a.tipo, a.monitor_id]);
        quitados++;
      }
    }

    // Agregar los nuevos, todos en el mismo lote
    const nuevos = [];
    const lote = crypto.randomBytes(24).toString('hex');
    for (const u of misUrls) {
      if (yaEstaba.has(clave('url', u.id))) continue;
      nuevos.push({ tipo: 'url', id: u.id, nombre: u.name || u.url, que: `Que ${u.url} responda correctamente.` });
    }
    for (const m of misSsls) {
      if (yaEstaba.has(clave('ssl', m.id))) continue;
      nuevos.push({ tipo: 'ssl', id: m.id, nombre: m.name || m.hostname, que: `Que el certificado de ${m.hostname} no venza sin aviso.` });
    }

    if (nuevos.length > 0) {
      for (const n of nuevos) {
        await pool.query(
          "INSERT INTO monitor_recipients (tipo, monitor_id, email, token, agregado_por, lote) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tipo, monitor_id, email) DO NOTHING",
          [n.tipo, n.id, correo, crypto.randomBytes(24).toString('hex'), req.user.id, lote]
        );
      }
      // El token del mail es el de la primera fila del lote: confirma todas.
      const primera = await pool.query('SELECT token FROM monitor_recipients WHERE lote = $1 AND email = $2 LIMIT 1', [lote, correo]);
      const duenio = await traerDuenio(req.user.id);
      if (primera.rows[0] && duenio) {
        await pedirPermisoLote(duenio, correo, primera.rows[0].token, nuevos);
      }
    }

    // Todos los monitores que cambiaron, agregados y quitados
    const tocados = new Set([...actuales.map(a => clave(a.tipo, a.monitor_id)), ...deseados]);
    for (const k of tocados) {
      const [t, id] = k.split(':');
      await recomputarNotifyEmails(t, Number(id));
    }

    logAudit(req.user.id, 'asignar_destinatario', 'monitor_recipients', null, `${correo}: +${nuevos.length} -${quitados}`, req.ip);
    res.json({ email: correo, agregados: nuevos.length, quitados });
  } catch (error) {
    console.error('Error asignando destinatario:', error.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Reenviar el pedido de permiso a alguien que todavia no acepto. Mismo token:
// si el mail anterior aparece despues, los dos enlaces siguen sirviendo.
app.post('/api/notificaciones/reenviar', authenticateToken, async (req, res) => {
  try {
    const { tipo, monitor_id, email } = req.body;
    if (!['url', 'ssl'].includes(tipo) || !monitor_id || !email) {
      return res.status(400).json({ error: 'Faltan datos' });
    }
    const correo = String(email).trim().toLowerCase();

    // Que el monitor sea suyo
    const tabla = tipo === 'ssl' ? 'ssl_monitors' : 'url_monitors';
    const m = await pool.query(`SELECT * FROM ${tabla} WHERE id = $1 AND user_id = $2`, [monitor_id, req.user.id]);
    if (m.rows.length === 0) return res.status(404).json({ error: 'Monitor no encontrado' });

    const d = await pool.query(
      'SELECT token, estado FROM monitor_recipients WHERE tipo = $1 AND monitor_id = $2 AND email = $3',
      [tipo, monitor_id, correo]
    );
    if (d.rows.length === 0) return res.status(404).json({ error: 'Ese correo no esta en este monitor' });
    if (d.rows[0].estado === 'confirmado') return res.status(400).json({ error: 'Ya habia aceptado, no hace falta reenviar' });

    // Si se habia dado de baja y el dueño reenvia, vuelve a pendiente: le
    // estamos volviendo a preguntar, no dandolo de alta por la fuerza.
    if (d.rows[0].estado === 'baja') {
      await pool.query("UPDATE monitor_recipients SET estado = 'pendiente', baja_at = NULL WHERE tipo = $1 AND monitor_id = $2 AND email = $3",
        [tipo, monitor_id, correo]);
    }

    const duenio = await traerDuenio(req.user.id);
    if (!duenio) return res.status(500).json({ error: 'Error interno' });
    const fila = m.rows[0];
    const nombre = fila.name || fila.url || fila.hostname;
    const que = tipo === 'ssl'
      ? `Que el certificado de ${fila.hostname} no venza sin aviso.`
      : `Que ${fila.url} responda correctamente.`;
    await pedirPermiso(duenio, correo, d.rows[0].token, nombre, que);
    await recomputarNotifyEmails(tipo, monitor_id);
    res.json({ message: `Reenviado a ${correo}` });
  } catch (error) {
    console.error('Error reenviando permiso:', error.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============== CONSENTIMIENTO DE DESTINATARIOS ==============
//
// Sin autenticacion a proposito: el destinatario no tiene cuenta. El token es
// aleatorio de 24 bytes y solo sirve para su propia suscripcion.

function paginaConsentimiento(icono, titulo, mensaje, color) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>ServerEyes</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a1628;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:20px}
  .caja{background:#0d1b2a;border-radius:16px;padding:40px 32px;max-width:460px;text-align:center;
    box-shadow:0 8px 40px rgba(0,0,0,.4)}
  .icono{font-size:52px;line-height:1;margin-bottom:16px}
  h1{color:${color};font-size:21px;margin:0 0 12px}
  p{color:#8fa3b8;font-size:15px;line-height:1.6;margin:0}
  .pie{color:#4a5f75;font-size:12px;margin-top:26px;border-top:1px solid #1a2a3a;padding-top:16px}
</style></head><body>
  <div class="caja">
    <div class="icono">${icono}</div>
    <h1>${titulo}</h1>
    <p>${mensaje}</p>
    <div class="pie">ServerEyes — monitoreo de sitios y servidores</div>
  </div>
</body></html>`;
}

app.get('/notificaciones/confirmar/:token', async (req, res) => {
  try {
    const q = await pool.query('SELECT id, email, estado, tipo, monitor_id, lote FROM monitor_recipients WHERE token = $1', [req.params.token]);
    const r = q.rows[0];
    if (!r) return res.status(404).send(paginaConsentimiento('🔍', 'Enlace no valido',
      'Este enlace no corresponde a ninguna suscripcion. Puede que ya se haya eliminado.', '#ff9800'));
    if (r.estado === 'confirmado') return res.send(paginaConsentimiento('✅', 'Ya estabas confirmado',
      `${r.email} ya recibe estos avisos. No hace falta hacer nada mas.`, '#00e676'));

    // Un clic confirma todo lo que se le pidio en el mismo mail. El email va en
    // la condicion para que un token no pueda confirmar filas de otra persona.
    const upd = await pool.query(
      "UPDATE monitor_recipients SET estado = 'confirmado', confirmado_at = NOW(), baja_at = NULL WHERE lote = $1 AND email = $2 AND estado = 'pendiente'",
      [r.lote || r.token, r.email]
    );
    const cuantos = upd.rowCount || 1;
    console.log(`[AVISO] ${r.email} confirmo ${cuantos} monitor(es) del lote ${(r.lote || r.token).slice(0, 8)}`);
    res.send(paginaConsentimiento('✅', 'Listo, quedaste suscripto',
      cuantos > 1
        ? `A partir de ahora ${r.email} va a recibir los avisos de los ${cuantos} sitios. Podes darte de baja cuando quieras desde el pie de cualquier mail.`
        : `A partir de ahora ${r.email} va a recibir un aviso cuando cambie el estado. Podes darte de baja cuando quieras desde el pie de cualquier mail.`,
      '#00e676'));
  } catch (e) {
    console.error('Error confirmando destinatario:', e.message);
    res.status(500).send(paginaConsentimiento('⚠️', 'Error', 'No pudimos procesar tu confirmacion. Intenta de nuevo en unos minutos.', '#ff5252'));
  }
});

app.get('/notificaciones/baja/:token', async (req, res) => {
  try {
    const q = await pool.query('SELECT id, email, estado, agregado_por FROM monitor_recipients WHERE token = $1', [req.params.token]);
    const r = q.rows[0];
    if (!r) return res.status(404).send(paginaConsentimiento('🔍', 'Enlace no valido',
      'Este enlace no corresponde a ninguna suscripcion.', '#ff9800'));

    await pool.query("UPDATE monitor_recipients SET estado = 'baja', baja_at = NOW() WHERE id = $1", [r.id]);
    console.log(`[AVISO] ${r.email} se dio de baja de un monitor`);

    // Si sigue anotado en otros, hay que decirselo y darle una salida de una
    // sola vez: si no, tendria que esperar a que se caiga cada sitio para
    // encontrar el enlace de baja de cada uno.
    const otros = await pool.query(
      "SELECT COUNT(*)::int AS n FROM monitor_recipients WHERE email = $1 AND agregado_por = $2 AND estado <> 'baja'",
      [r.email, r.agregado_por]
    );
    const n = otros.rows[0]?.n || 0;
    const extra = n > 0
      ? `<div style="margin-top:22px;border-top:1px solid #1a2a3a;padding-top:18px">
           <p style="color:#8fa3b8;font-size:14px;margin:0 0 14px">Seguis anotado en <strong style="color:#fff">${n}</strong> sitio${n > 1 ? 's' : ''} mas de la misma persona.</p>
           <a href="${urlPublica()}/notificaciones/baja-total/${req.params.token}"
              style="display:inline-block;background:#ff5252;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:8px">No quiero recibir ninguno</a>
         </div>`
      : '';
    res.send(paginaConsentimiento('👋', 'Listo, no te escribimos mas',
      `${r.email} no va a recibir mas avisos de este monitor.` + extra, '#00d4ff'));
  } catch (e) {
    console.error('Error dando de baja:', e.message);
    res.status(500).send(paginaConsentimiento('⚠️', 'Error', 'No pudimos procesar la baja. Intenta de nuevo en unos minutos.', '#ff5252'));
  }
});

app.get('/notificaciones/baja-total/:token', async (req, res) => {
  try {
    const q = await pool.query('SELECT email, agregado_por FROM monitor_recipients WHERE token = $1', [req.params.token]);
    const r = q.rows[0];
    if (!r) return res.status(404).send(paginaConsentimiento('🔍', 'Enlace no valido',
      'Este enlace no corresponde a ninguna suscripcion.', '#ff9800'));

    const upd = await pool.query(
      "UPDATE monitor_recipients SET estado = 'baja', baja_at = NOW() WHERE email = $1 AND agregado_por = $2 AND estado <> 'baja'",
      [r.email, r.agregado_por]
    );
    console.log(`[AVISO] ${r.email} se dio de baja de TODO (${upd.rowCount} monitor(es))`);
    res.send(paginaConsentimiento('👋', 'Listo, no te escribimos mas',
      `${r.email} no va a recibir ningun aviso mas de esta persona. Se dio de baja de ${upd.rowCount} sitio${upd.rowCount === 1 ? '' : 's'}.`, '#00d4ff'));
  } catch (e) {
    console.error('Error en baja total:', e.message);
    res.status(500).send(paginaConsentimiento('⚠️', 'Error', 'No pudimos procesar la baja. Intenta de nuevo en unos minutos.', '#ff5252'));
  }
});

// ============== STATUS PAGE PUBLICA ==============

app.get('/status-page', (req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));

// Sin slug no hay pagina: devolver el inventario global era la fuga.
app.get('/api/public/status', (req, res) => {
  res.status(400).json({ error: 'Falta el identificador de la pagina de estado' });
});

// Configuracion de la pagina de estado de mi organizacion
app.get('/api/organization/status-page', authenticateToken, async (req, res) => {
  try {
    const u = await pool.query('SELECT organization_id FROM users WHERE id = $1', [req.user.id]);
    const orgId = u.rows[0]?.organization_id;
    if (!orgId) return res.status(404).json({ error: 'No perteneces a ninguna organizacion' });
    const org = await pool.query('SELECT status_slug, status_enabled, owner_id FROM organizations WHERE id = $1', [orgId]);
    if (org.rows.length === 0) return res.status(404).json({ error: 'Organizacion no encontrada' });
    const o = org.rows[0];
    res.json({
      enabled: o.status_enabled === true,
      slug: o.status_slug || null,
      url: o.status_slug ? `/status-page?s=${o.status_slug}` : null,
      soy_owner: o.owner_id === req.user.id
    });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Prender/apagar la pagina, o rotar el slug. Solo el dueño de la organizacion.
app.post('/api/organization/status-page', authenticateToken, async (req, res) => {
  try {
    const { enabled, rotar } = req.body;
    const u = await pool.query('SELECT organization_id FROM users WHERE id = $1', [req.user.id]);
    const orgId = u.rows[0]?.organization_id;
    if (!orgId) return res.status(404).json({ error: 'No perteneces a ninguna organizacion' });
    const org = await pool.query('SELECT status_slug, owner_id FROM organizations WHERE id = $1', [orgId]);
    if (org.rows[0]?.owner_id !== req.user.id) return res.status(403).json({ error: 'Solo el dueño de la organizacion puede cambiar esto' });

    let slug = org.rows[0].status_slug;
    if (!slug || rotar) slug = crypto.randomBytes(16).toString('base64url');
    await pool.query('UPDATE organizations SET status_slug = $1, status_enabled = $2 WHERE id = $3', [slug, enabled !== false, orgId]);
    logAudit(req.user.id, 'config_status_page', 'organization', orgId, `enabled=${enabled !== false} rotar=${!!rotar}`, req.ip);
    res.json({ enabled: enabled !== false, slug, url: `/status-page?s=${slug}` });
  } catch (error) {
    console.error('Error configurando status page:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/public/status/:slug', async (req, res) => {
  try {
    const org = await pool.query(
      'SELECT id FROM organizations WHERE status_slug = $1 AND status_enabled = true',
      [req.params.slug]
    );
    // Mismo 404 si el slug no existe o si la pagina esta apagada: no confirmamos
    // la existencia de organizaciones a quien vaya probando slugs.
    if (org.rows.length === 0) return res.status(404).json({ error: 'Pagina de estado no encontrada' });
    const orgId = org.rows[0].id;

    const result = await pool.query(
      `SELECT m.machine_name, m.is_online, m.last_heartbeat, m.ping_ms, m.geo_city, m.geo_country
       FROM machines m
       JOIN users u ON m.user_id = u.id
       WHERE u.organization_id = $1
       ORDER BY m.machine_name`,
      [orgId]
    );

    // last_error queda afuera a proposito: suele traer hostnames y rutas
    // internas, y esto lo ve cualquiera.
    const urlMonitors = await pool.query(
      `SELECT um.name, um.url, um.is_up, um.last_response_ms, um.last_check
       FROM url_monitors um
       JOIN users u ON um.user_id = u.id
       WHERE um.is_active = true AND u.organization_id = $1`,
      [orgId]
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
      last_check: u.last_check
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
