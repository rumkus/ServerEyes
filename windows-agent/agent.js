const https = require('https');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const { spawn } = require('child_process');

const AGENT_VERSION = '1.0.2';
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

function getLastLogs(count) {
  try {
    if (!fs.existsSync(LOG_FILE)) return '';
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n');
    return lines.slice(-count).join('\n');
  } catch { return ''; }
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

// Metricas del sistema (CPU, RAM, todos los Discos)
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

      // Obtener TODOS los discos fijos (DriveType=3)
      exec('wmic logicaldisk where "DriveType=3" get DeviceID,Size,FreeSpace /format:csv', (err2, diskOut) => {
        const disks = [];
        let diskUsage = null, diskTotal = null; // mantener C: para compatibilidad
        if (!err2) {
          const lines = diskOut.trim().split('\n').filter(l => l.trim() && !l.startsWith('Node'));
          for (const line of lines) {
            const parts = line.trim().split(',');
            // CSV: Node,DeviceID,FreeSpace,Size
            if (parts.length >= 4) {
              const drive = parts[1];
              const free = parseInt(parts[2]);
              const total = parseInt(parts[3]);
              if (total > 0) {
                const dTotal = Math.round(total / 1024 / 1024 / 1024 * 10) / 10;
                const dUsage = Math.round((total - free) / 1024 / 1024 / 1024 * 10) / 10;
                disks.push({ drive, total: dTotal, used: dUsage, free: Math.round(free / 1024 / 1024 / 1024 * 10) / 10 });
                if (drive === 'C:') { diskTotal = dTotal; diskUsage = dUsage; }
              }
            }
          }
        }
        resolve({ cpu_usage: cpuUsage, ram_usage: ramUsage, ram_total: ramTotal, disk_usage: diskUsage, disk_total: diskTotal, disks });
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

// Auto-update: descarga nuevo exe, renombra viejo, pone nuevo en su lugar
async function selfUpdate(url, newVersion, config) {
  const newPath = path.join(EXE_DIR, 'servereyes-new.exe');
  const oldPath = path.join(EXE_DIR, 'servereyes-old.exe');
  const batPath = path.join(EXE_DIR, 'servereyes-update.bat');

  log(`Descargando actualizacion v${newVersion} desde ${url}`);
  try {
    // Descargar archivo siguiendo redirects
    await new Promise((resolve, reject) => {
      const downloadFile = (downloadUrl, redirects) => {
        if (redirects > 5) { reject(new Error('Demasiados redirects')); return; }
        const client = downloadUrl.startsWith('https') ? https : http;
        client.get(downloadUrl, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            downloadFile(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          const file = fs.createWriteStream(newPath);
          res.pipe(file);
          file.on('finish', () => { file.close(resolve); });
          file.on('error', reject);
        }).on('error', reject);
      };
      downloadFile(url, 0);
    });

    // Verificar que el archivo descargado tiene tamaño razonable (>1MB)
    const stats = fs.statSync(newPath);
    if (stats.size < 1024 * 1024) {
      log('Archivo descargado muy chico, abortando update');
      try { fs.unlinkSync(newPath); } catch {}
      return;
    }

    log(`Descarga completa (${Math.round(stats.size / 1024 / 1024)}MB), aplicando update...`);

    // Estrategia: el bat renombra el exe actual (se puede renombrar un exe en uso),
    // mueve el nuevo al nombre original, y lo arranca.
    // El watchdog tambien ayuda a levantarlo si el bat falla.
    const exeName = path.basename(EXE_PATH);
    const batContent = [
      '@echo off',
      'timeout /t 5 /nobreak >nul',
      // Limpiar old anterior si existe
      `if exist "${oldPath}" del /f "${oldPath}"`,
      // Renombrar exe actual a old (Windows permite renombrar exe en uso)
      `if exist "${EXE_PATH}" rename "${EXE_PATH}" servereyes-old.exe`,
      // Mover nuevo al nombre correcto
      `if exist "${newPath}" move /y "${newPath}" "${EXE_PATH}"`,
      // Arrancar
      `if exist "${EXE_PATH}" start "" "${EXE_PATH}"`,
      // Limpiar bat
      'del "%~f0"'
    ].join('\r\n') + '\r\n';
    fs.writeFileSync(batPath, batContent);

    log('Reiniciando con nueva version...');
    spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

    // Esperar un momento para que el bat se lance antes de salir
    setTimeout(() => process.exit(0), 1000);
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
        ping_ms: pingMs, agent_version: AGENT_VERSION, agent_type: 'agent', agent_logs: getLastLogs(30), ...metrics
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
  const exeName = path.basename(EXE_PATH);

  // Crear VBS que lanza el exe oculto
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run chr(34) & "${EXE_PATH.replace(/\\/g, '\\\\')}" & chr(34), 0, False\r\n`;
  fs.writeFileSync(VBS_FILE, vbsContent);

  // Crear VBS watchdog que chequea si el proceso existe y lo levanta si no (100% silencioso)
  const watchdogVbs = path.join(EXE_DIR, 'ServerEyes-Watchdog.vbs');
  const tempCheck = 'fso.GetSpecialFolder(2) & "\\se_check.tmp"';
  const watchdogContent = [
    'Set WshShell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `tempFile = ${tempCheck}`,
    `WshShell.Run "cmd /c tasklist /FI ""IMAGENAME eq ${exeName}"" /NH > """ & tempFile & """", 0, True`,
    'If fso.FileExists(tempFile) Then',
    '  Set f = fso.OpenTextFile(tempFile, 1)',
    '  strOutput = f.ReadAll',
    '  f.Close',
    '  fso.DeleteFile tempFile',
    `  If InStr(strOutput, "${exeName}") = 0 Then`,
    `    WshShell.Run chr(34) & "${EXE_PATH}" & chr(34), 0, False`,
    '  End If',
    'End If',
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(watchdogVbs, watchdogContent);

  try {
    // Tarea principal: arrancar al iniciar sesion
    execSync(`schtasks /Create /TN "${TASK_NAME}" /TR "wscript.exe \\"${VBS_FILE}\\"" /SC ONLOGON /RL HIGHEST /F`, { stdio: 'pipe' });
    console.log('\nInstalado como tarea programada.');
    console.log('El agente se ejecutara automaticamente al iniciar Windows (sin ventana).');
  } catch (err) {
    try {
      execSync(`schtasks /Create /TN "${TASK_NAME}" /TR "wscript.exe \\"${VBS_FILE}\\"" /SC ONLOGON /F`, { stdio: 'pipe' });
      console.log('\nInstalado como tarea programada.');
    } catch {
      console.log('Error al instalar tarea principal. Ejecuta como Administrador.');
    }
  }

  try {
    // Tarea watchdog: cada 20 segundos chequea si esta corriendo, si no lo levanta
    // schtasks no soporta intervalos menores a 1 minuto, asi que usamos /RI 1 (repetir cada 1 min)
    // y dentro del VBS ya chequea si el proceso existe
    execSync(`schtasks /Create /TN "${TASK_NAME} Watchdog" /TR "wscript.exe \\"${watchdogVbs}\\"" /SC MINUTE /MO 1 /RL HIGHEST /F`, { stdio: 'pipe' });
    console.log('Watchdog instalado (chequea cada 1 minuto si el agente esta corriendo).');
  } catch {
    try {
      execSync(`schtasks /Create /TN "${TASK_NAME} Watchdog" /TR "wscript.exe \\"${watchdogVbs}\\"" /SC MINUTE /MO 1 /F`, { stdio: 'pipe' });
      console.log('Watchdog instalado (chequea cada 1 minuto si el agente esta corriendo).');
    } catch {
      console.log('No se pudo instalar el watchdog. El agente igual arrancara al iniciar Windows.');
    }
  }

  console.log(`\nPara desinstalar: ${exeName} --uninstall`);
}

function uninstall() {
  const watchdogVbs = path.join(EXE_DIR, 'ServerEyes-Watchdog.vbs');
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
  } catch {}
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME} Watchdog" /F`, { stdio: 'pipe' });
  } catch {}
  try { if (fs.existsSync(VBS_FILE)) fs.unlinkSync(VBS_FILE); } catch {}
  try { if (fs.existsSync(watchdogVbs)) fs.unlinkSync(watchdogVbs); } catch {}
  console.log('Tareas programadas y archivos auxiliares eliminados.');
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
