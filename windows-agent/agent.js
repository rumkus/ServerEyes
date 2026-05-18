const https = require('https');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const { spawn } = require('child_process');

const AGENT_VERSION = '1.0.0';
const EXE_PATH = process.execPath;
const EXE_DIR = path.dirname(EXE_PATH);
const CONFIG_FILE = path.join(EXE_DIR, 'servereyes-config.json');
const LOG_FILE = path.join(EXE_DIR, 'servereyes.log');
const VBS_FILE = path.join(EXE_DIR, 'ServerEyes-Silent.vbs');
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

// Metricas del sistema (CPU, RAM, Disco)
function getSystemMetrics() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec('wmic cpu get loadpercentage /value', (err, cpuOut) => {
      let cpuUsage = null;
      if (!err) {
        const match = cpuOut.match(/LoadPercentage=(\d+)/);
        if (match) cpuUsage = parseInt(match[1]);
      }
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const ramTotal = Math.round(totalMem / 1024 / 1024 / 1024 * 10) / 10;
      const ramUsage = Math.round((totalMem - freeMem) / 1024 / 1024 / 1024 * 10) / 10;
      exec('wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace /value', (err2, diskOut) => {
        let diskTotal = null, diskUsage = null;
        if (!err2) {
          const freeMatch = diskOut.match(/FreeSpace=(\d+)/);
          const sizeMatch = diskOut.match(/Size=(\d+)/);
          if (freeMatch && sizeMatch) {
            const total = parseInt(sizeMatch[1]);
            const free = parseInt(freeMatch[1]);
            diskTotal = Math.round(total / 1024 / 1024 / 1024 * 10) / 10;
            diskUsage = Math.round((total - free) / 1024 / 1024 / 1024 * 10) / 10;
          }
        }
        resolve({ cpu_usage: cpuUsage, ram_usage: ramUsage, ram_total: ramTotal, disk_usage: diskUsage, disk_total: diskTotal });
      });
    });
  });
}

// Ping a google.com
function measurePing() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec('ping -n 1 -w 3000 8.8.8.8', (err, stdout) => {
      if (err) { resolve(null); return; }
      // Buscar "time=XXms" o "tiempo=XXms"
      const match = stdout.match(/(?:time|tiempo)[=<](\d+)/i);
      resolve(match ? parseInt(match[1]) : null);
    });
  });
}

// Speed test (descarga un archivo y mide velocidad)
async function measureSpeed() {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let bytes = 0;
    // Descargar 5MB de Cloudflare para medir download
    const url = 'https://speed.cloudflare.com/__down?bytes=5000000';
    https.get(url, (res) => {
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => {
        const duration = (Date.now() - startTime) / 1000;
        const mbps = ((bytes * 8) / (1024 * 1024)) / duration;
        resolve({ download: Math.round(mbps * 100) / 100 });
      });
    }).on('error', () => resolve(null));

    // Timeout 15s
    setTimeout(() => resolve(null), 15000);
  });
}

// Auto-update: descarga nuevo exe, crea un bat que reemplaza y reinicia
async function selfUpdate(url, newVersion, config) {
  const newPath = path.join(EXE_DIR, 'servereyes-new.exe');
  const batPath = path.join(EXE_DIR, 'servereyes-update.bat');

  log(`Descargando actualizacion v${newVersion} desde ${url}`);
  try {
    // Descargar archivo
    await new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const download = (downloadUrl) => {
        client.get(downloadUrl, (res) => {
          // Seguir redirects
          if (res.statusCode === 301 || res.statusCode === 302) {
            const redirectClient = res.headers.location.startsWith('https') ? https : http;
            redirectClient.get(res.headers.location, (res2) => {
              if (res2.statusCode !== 200) { reject(new Error(`HTTP ${res2.statusCode}`)); return; }
              const file = fs.createWriteStream(newPath);
              res2.pipe(file);
              file.on('finish', () => { file.close(); resolve(); });
            }).on('error', reject);
            return;
          }
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          const file = fs.createWriteStream(newPath);
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      };
      download(url);
    });

    // Verificar que el archivo descargado tiene tamaño razonable (>1MB)
    const stats = fs.statSync(newPath);
    if (stats.size < 1024 * 1024) {
      log('Archivo descargado muy chico, abortando update');
      fs.unlinkSync(newPath);
      return;
    }

    log(`Descarga completa (${Math.round(stats.size / 1024 / 1024)}MB), aplicando update...`);

    // Crear bat que espera, reemplaza y reinicia
    const exeName = path.basename(EXE_PATH);
    const batContent = `@echo off\r\ntimeout /t 3 /nobreak >nul\r\ndel "${EXE_PATH}" 2>nul\r\nmove "${newPath}" "${EXE_PATH}" >nul\r\nstart "" "${EXE_PATH}"\r\ndel "%~f0"\r\n`;
    fs.writeFileSync(batPath, batContent);

    log('Reiniciando con nueva version...');
    spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();
    process.exit(0);
  } catch (err) {
    log(`Error en update: ${err.message}`);
    try { if (fs.existsSync(newPath)) fs.unlinkSync(newPath); } catch {}
  }
}

// Heartbeat
async function sendHeartbeat(config) {
  if (!config.serverUrl || !config.machineKey) return;
  try {
    const publicIP = await getPublicIP();
    const pingMs = await measurePing();
    const metrics = await getSystemMetrics();
    const res = await httpRequest(`${config.serverUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_key: config.machineKey, machine_name: config.machineName,
        public_ip: publicIP, local_ip: getLocalIP(), os_info: getOSInfo(),
        ping_ms: pingMs, agent_version: AGENT_VERSION, ...metrics
      })
    });
    if (res.ok) {
      log(`Heartbeat OK - IP: ${publicIP} - Ping: ${pingMs || '?'}ms - v${AGENT_VERSION}`);

      // Chequear si hay actualizacion disponible
      if (res.data && res.data.update && res.data.update.url) {
        log(`Actualizacion disponible: v${res.data.update.version}`);
        await selfUpdate(res.data.update.url, res.data.update.version, config);
      }

      // Chequear si el server pide speed test
      if (res.data && res.data.run_speedtest) {
        log('Speed test solicitado, ejecutando...');
        const speed = await measureSpeed();
        if (speed) {
          log(`Speed test: Download ${speed.download} Mbps`);
          await httpRequest(`${config.serverUrl}/api/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              machine_key: config.machineKey, download_mbps: speed.download
            })
          });
        }
      }
    } else log(`Heartbeat ERROR: ${JSON.stringify(res.data)}`);
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
