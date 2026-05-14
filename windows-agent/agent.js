const https = require('https');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const EXE_PATH = process.execPath;
const CONFIG_FILE = path.join(path.dirname(EXE_PATH), 'servereyes-config.json');
const LOG_FILE = path.join(path.dirname(EXE_PATH), 'servereyes.log');
const VBS_FILE = path.join(path.dirname(EXE_PATH), 'ServerEyes-Silent.vbs');
const TASK_NAME = 'ServerEyes Agent';

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return { serverUrl: '', machineKey: '', machineName: os.hostname(), heartbeatInterval: 30 };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function log(msg) {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// HTTP
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: options.method || 'GET', headers: options.headers || {}, timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, data: JSON.parse(data) }); }
        catch { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// IPs activas
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  const skip = [/vmware/i,/virtualbox/i,/vbox/i,/hyper-v/i,/docker/i,/vethernet/i,/vpn/i,/tap/i,/tun/i,/wireguard/i,/bluetooth/i,/loopback/i,/teredo/i,/isatap/i];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (skip.some(p => p.test(name))) continue;
    for (const iface of addrs) {
      if (iface.family !== 'IPv4' || iface.internal || iface.address.startsWith('169.254.')) continue;
      ips.push(`${iface.address} (${name})`);
    }
  }
  return ips.length > 0 ? ips.join(' | ') : '127.0.0.1';
}

async function getPublicIP() {
  try { const r = await httpRequest('https://api.ipify.org?format=json'); return r.data.ip; }
  catch { return null; }
}

function getOSInfo() {
  return `${os.type()} ${os.release()} | ${os.cpus()[0]?.model || 'Unknown'} | RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`;
}

// Heartbeat
async function sendHeartbeat(config) {
  if (!config.serverUrl || !config.machineKey) return;
  try {
    const publicIP = await getPublicIP();
    const res = await httpRequest(`${config.serverUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_key: config.machineKey, machine_name: config.machineName,
        public_ip: publicIP, local_ip: getLocalIP(), os_info: getOSInfo()
      })
    });
    if (res.ok) log(`Heartbeat OK - IP: ${publicIP}`);
    else log(`Heartbeat ERROR: ${JSON.stringify(res.data)}`);
  } catch (err) { log(`Heartbeat FAILED: ${err.message}`); }
}

// Heartbeat loop
function startHeartbeatLoop(config) {
  log(`Agente iniciado - ${config.machineName}`);
  log(`Servidor: ${config.serverUrl}`);
  log(`Intervalo: ${config.heartbeatInterval}s`);
  sendHeartbeat(config);
  setInterval(() => sendHeartbeat(config), (config.heartbeatInterval || 30) * 1000);
}

// Pairing con espera sincrona
function startPairing(config) {
  return new Promise(async (resolve) => {
    try {
      const res = await httpRequest(`${config.serverUrl}/api/pairing/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machine_name: config.machineName, os_info: getOSInfo() })
      });
      if (!res.ok) { console.log('Error:', res.data.error); resolve(false); return; }

      console.log(`\n  CODIGO: ${res.data.code}\n`);
      console.log('  Ingresa este codigo en la app del celular.');
      console.log('  Esperando confirmacion...\n');

      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        if (attempts > 150) { clearInterval(poll); console.log('  Codigo expirado.'); resolve(false); return; }
        try {
          const check = await httpRequest(`${config.serverUrl}/api/pairing/status/${res.data.code}`);
          if (check.ok && check.data.confirmed) {
            clearInterval(poll);
            config.machineKey = check.data.machine_key;
            saveConfig(config);
            console.log('  VINCULADO! La clave se guardo automaticamente.\n');
            resolve(true);
          }
        } catch {}
      }, 2000);
    } catch (err) { console.log('Error:', err.message); resolve(false); }
  });
}

// Instalar como tarea programada (corre sin ventana al iniciar Windows)
function install() {
  // Crear VBS que lanza el exe oculto
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run chr(34) & "${EXE_PATH.replace(/\\/g, '\\\\')}" & chr(34), 0, False\r\n`;
  fs.writeFileSync(VBS_FILE, vbsContent);

  try {
    execSync(`schtasks /Create /TN "${TASK_NAME}" /TR "wscript.exe \\"${VBS_FILE}\\"" /SC ONLOGON /RL HIGHEST /F`, { stdio: 'pipe' });
    console.log('\nInstalado como tarea programada.');
    console.log('El agente se ejecutara automaticamente al iniciar Windows (sin ventana).');
    console.log(`\nPara desinstalar: ${path.basename(EXE_PATH)} --uninstall`);
  } catch (err) {
    // Intentar sin /RL HIGHEST si falla
    try {
      execSync(`schtasks /Create /TN "${TASK_NAME}" /TR "wscript.exe \\"${VBS_FILE}\\"" /SC ONLOGON /F`, { stdio: 'pipe' });
      console.log('\nInstalado como tarea programada.');
      console.log('El agente se ejecutara automaticamente al iniciar Windows (sin ventana).');
    } catch {
      console.log('Error al instalar tarea. Ejecuta como Administrador.');
    }
  }
}

function uninstall() {
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
    if (fs.existsSync(VBS_FILE)) fs.unlinkSync(VBS_FILE);
    console.log('Tarea programada eliminada.');
  } catch {
    console.log('No se encontro la tarea o ya fue eliminada.');
  }
}

// Setup interactivo
async function setup() {
  const config = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  console.log('\n=== ServerEyes Agent - Configuracion ===\n');
  console.log(`Config actual:`);
  console.log(`  Servidor: ${config.serverUrl || '(no configurado)'}`);
  console.log(`  Clave:    ${config.machineKey ? config.machineKey.slice(0, 8) + '...' : '(no configurado)'}`);
  console.log(`  Nombre:   ${config.machineName}\n`);

  const serverUrl = await ask(`URL del servidor [${config.serverUrl || 'https://servereyes-production.up.railway.app'}]: `);
  if (serverUrl.trim()) config.serverUrl = serverUrl.trim().replace(/\/$/, '');
  else if (!config.serverUrl) config.serverUrl = 'https://servereyes-production.up.railway.app';

  const name = await ask(`Nombre de esta maquina [${config.machineName}]: `);
  if (name.trim()) config.machineName = name.trim();

  console.log('\nComo queres vincular?');
  console.log('  1) Codigo de vinculacion (desde la app del celular)');
  console.log('  2) Ingresar clave manualmente');
  const choice = await ask('\nOpcion [1]: ');

  if (choice.trim() === '2') {
    const key = await ask('Clave de maquina: ');
    if (key.trim()) config.machineKey = key.trim();
    saveConfig(config);
  } else {
    saveConfig(config);
    const paired = await startPairing(config);
    if (!paired) { rl.close(); return; }
  }

  // Preguntar si instalar
  const doInstall = await ask('Instalar para que arranque con Windows? (s/n) [s]: ');
  if (doInstall.trim().toLowerCase() !== 'n') {
    install();
  }

  rl.close();

  // Arrancar heartbeat automaticamente
  console.log('\nIniciando heartbeat...\n');
  startHeartbeatLoop(loadConfig());
}

// Main
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--setup') || args.includes('-s')) {
    await setup();
    return;
  }

  if (args.includes('--install')) { install(); return; }
  if (args.includes('--uninstall')) { uninstall(); return; }

  const config = loadConfig();

  if (!config.serverUrl || !config.machineKey) {
    console.log('ServerEyes Agent - No configurado');
    console.log(`Ejecuta: ${path.basename(EXE_PATH)} --setup`);
    return;
  }

  startHeartbeatLoop(config);
}

main().catch(console.error);
