const electron = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, dialog } = electron;

const CLIENT_VERSION = '1.0.0';
let tray = null;
const _clientLogs = [];
function clog(msg) { const line = `[${new Date().toLocaleString()}] ${msg}`; _clientLogs.push(line); if (_clientLogs.length > 50) _clientLogs.splice(0, _clientLogs.length - 50); }
function getClientLogs() { return _clientLogs.slice(-30).join('\n'); }
let configWindow = null;
let heartbeatTimer = null;
let configPath = null;

// Config con JSON simple
function getConfigPath() {
  if (!configPath) {
    configPath = path.join(app.getPath('userData'), 'config.json');
  }
  return configPath;
}

function loadConfig() {
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) {}
  return {
    serverUrl: '',
    machineKey: '',
    machineName: os.hostname(),
    heartbeatInterval: 30
  };
}

function saveConfig(config) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// HTTP request simple
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 10000
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

// Obtener IP publica
async function getPublicIP() {
  try {
    const res = await httpRequest('https://api.ipify.org?format=json');
    return res.data.ip;
  } catch {
    return null;
  }
}

// Obtener IPs locales solo de adaptadores fisicos (Ethernet y Wi-Fi)
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const activeIPs = [];

  // Nombres de adaptadores virtuales a ignorar
  const virtualPatterns = [
    /vmware/i, /virtualbox/i, /vbox/i, /hyper-v/i,
    /docker/i, /vethernet/i, /vpn/i, /tap/i, /tun/i,
    /wireguard/i, /wg\d/i, /nordlynx/i, /proton/i,
    /fortinet/i, /cisco/i, /juniper/i, /palo alto/i,
    /npcap/i, /loopback/i, /pseudo/i, /teredo/i,
    /isatap/i, /6to4/i, /bluetooth/i,
  ];

  for (const [name, addrs] of Object.entries(interfaces)) {
    // Saltar adaptadores virtuales
    if (virtualPatterns.some(p => p.test(name))) continue;

    for (const iface of addrs) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.startsWith('169.254.')) continue;
      activeIPs.push(`${iface.address} (${name})`);
    }
  }

  return activeIPs.length > 0 ? activeIPs.join(' | ') : '127.0.0.1';
}

// Info del sistema
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

      exec('wmic logicaldisk where "DriveType=3" get DeviceID,Size,FreeSpace /format:csv', (err2, diskOut) => {
        const disks = [];
        let diskUsage = null, diskTotal = null;
        if (!err2) {
          const lines = diskOut.trim().split('\n').filter(l => l.trim() && !l.startsWith('Node'));
          for (const line of lines) {
            const parts = line.trim().split(',');
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

// Ping
function measurePing() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec('ping -n 1 -w 3000 8.8.8.8', (err, stdout) => {
      if (err) { resolve(null); return; }
      const match = stdout.match(/(?:time|tiempo)[=<](\d+)/i);
      resolve(match ? parseInt(match[1]) : null);
    });
  });
}

// Speed test
function measureSpeed() {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let bytes = 0;
    https.get('https://speed.cloudflare.com/__down?bytes=5000000', (res) => {
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => {
        const duration = (Date.now() - startTime) / 1000;
        const mbps = ((bytes * 8) / (1024 * 1024)) / duration;
        resolve({ download: Math.round(mbps * 100) / 100 });
      });
    }).on('error', () => resolve(null));
    setTimeout(() => resolve(null), 15000);
  });
}

// Auto-update del client
async function selfUpdateClient(url, newVersion) {
  const { spawn } = require('child_process');
  const exePath = process.execPath; // ruta del electron exe
  const exeDir = path.dirname(exePath);
  const newPath = path.join(exeDir, 'servereyes-client-new.exe');
  const oldPath = path.join(exeDir, 'servereyes-client-old.exe');
  const batPath = path.join(exeDir, 'servereyes-client-update.bat');

  clog(`Descargando v${newVersion} desde ${url}`);

  // Descargar siguiendo redirects
  await new Promise((resolve, reject) => {
    const downloadFile = (downloadUrl, redirects) => {
      if (redirects > 5) { reject(new Error('Demasiados redirects')); return; }
      const client = downloadUrl.startsWith('https') ? https : http;
      client.get(downloadUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          downloadFile(res.headers.location, redirects + 1); return;
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

  const stats = fs.statSync(newPath);
  if (stats.size < 1024 * 1024) {
    clog('Archivo muy chico, abortando');
    try { fs.unlinkSync(newPath); } catch {}
    return;
  }

  clog(`Descarga completa (${Math.round(stats.size / 1024 / 1024)}MB), reiniciando...`);

  const exeName = path.basename(exePath);
  const batContent = [
    '@echo off',
    'timeout /t 5 /nobreak >nul',
    `if exist "${oldPath}" del /f "${oldPath}"`,
    `if exist "${exePath}" rename "${exePath}" servereyes-client-old.exe`,
    `if exist "${newPath}" move /y "${newPath}" "${exePath}"`,
    `if exist "${exePath}" start "" "${exePath}"`,
    'del "%~f0"'
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(batPath, batContent);

  spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => { app.isQuiting = true; app.quit(); }, 1000);
}

// Enviar heartbeat
async function sendHeartbeat() {
  const config = loadConfig();
  if (!config.serverUrl || !config.machineKey) {
    if (tray) tray.setToolTip('ServerEyes - No configurado');
    return;
  }

  try {
    const publicIP = await getPublicIP();
    const pingMs = await measurePing();
    const metrics = await getSystemMetrics();
    const res = await httpRequest(`${config.serverUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_key: config.machineKey,
        machine_name: config.machineName,
        public_ip: publicIP,
        local_ip: getLocalIP(),
        os_info: getOSInfo(),
        ping_ms: pingMs,
        agent_version: CLIENT_VERSION,
        agent_type: 'client',
        agent_logs: getClientLogs(),
        ...metrics
      })
    });
    clog(`Heartbeat OK - ${publicIP} - ${pingMs || '?'}ms`);

    if (tray) tray.setToolTip(res.ok ? `ServerEyes v${CLIENT_VERSION} - ${publicIP} - ${pingMs || '?'}ms` : 'ServerEyes - Error');

    // Auto-update si hay version nueva
    if (res.ok && res.data && res.data.update && res.data.update.url) {
      const { version, url } = res.data.update;
      clog(`Update disponible: v${version}`);
      if (tray) tray.setToolTip(`ServerEyes v${CLIENT_VERSION} - Actualizando a v${version}...`);
      try {
        await selfUpdateClient(url, version);
      } catch (e) { clog(`Update error: ${e.message}`); }
    }

    // Speed test si el servidor lo pide
    if (res.ok && res.data && res.data.run_speedtest) {
      const speed = await measureSpeed();
      if (speed) {
        await httpRequest(`${config.serverUrl}/api/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ machine_key: config.machineKey, download_mbps: speed.download })
        });
      }
    }
  } catch (error) {
    if (tray) tray.setToolTip('ServerEyes - Sin conexion');
  }
}

// Cargar icono ICO nativo de Windows
function createTrayIcon() {
  const iconPath = path.join(__dirname, 'icon.ico');
  return nativeImage.createFromPath(iconPath);
}

// Ventana de configuracion
function openConfigWindow() {
  if (configWindow) { configWindow.focus(); return; }

  configWindow = new BrowserWindow({
    width: 480, height: 520,
    resizable: false, maximizable: false, minimizable: false,
    title: 'ServerEyes - Configuracion',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  configWindow.setMenuBarVisibility(false);
  configWindow.loadFile(path.join(__dirname, 'config.html'));
  configWindow.on('closed', () => { configWindow = null; });
}

// Ventana de pairing (vincular equipo)
let pairingWindow = null;

function openPairingWindow() {
  const config = loadConfig();
  if (!config.serverUrl) {
    openConfigWindow();
    return;
  }
  if (pairingWindow) { pairingWindow.focus(); return; }

  pairingWindow = new BrowserWindow({
    width: 400, height: 350,
    resizable: false, maximizable: false, minimizable: false,
    title: 'ServerEyes - Vincular equipo',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  pairingWindow.setMenuBarVisibility(false);
  pairingWindow.loadFile(path.join(__dirname, 'pairing.html'));
  pairingWindow.on('closed', () => { pairingWindow = null; });
}

// Iniciar heartbeat
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const config = loadConfig();
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, (config.heartbeatInterval || 30) * 1000);
}

// Single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => openConfigWindow());
}

// App ready
app.whenReady().then(() => {
  // IPC
  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('save-config', (e, config) => {
    saveConfig(config);
    startHeartbeat();
    return { success: true };
  });
  ipcMain.handle('test-connection', async () => {
    const config = loadConfig();
    if (!config.serverUrl) return { success: false, message: 'URL no configurada' };
    try {
      const res = await httpRequest(`${config.serverUrl}/api/status`);
      return res.ok ? { success: true, message: 'Conexion exitosa' } : { success: false, message: 'Servidor no responde' };
    } catch (error) {
      return { success: false, message: `Error: ${error.message}` };
    }
  });

  // Pairing IPC
  ipcMain.handle('request-pairing', async () => {
    const config = loadConfig();
    if (!config.serverUrl) return { success: false, message: 'Configura la URL del servidor primero' };
    try {
      const machineName = config.machineName || os.hostname();
      const osInfo = `${os.type()} ${os.release()} | ${os.cpus()[0]?.model || 'Unknown'} | RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`;
      const res = await httpRequest(`${config.serverUrl}/api/pairing/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machine_name: machineName, os_info: osInfo })
      });
      if (res.ok) return { success: true, code: res.data.code };
      return { success: false, message: res.data.error || 'Error' };
    } catch (error) {
      return { success: false, message: `Error: ${error.message}` };
    }
  });

  ipcMain.handle('check-pairing', async (e, code) => {
    const config = loadConfig();
    try {
      const res = await httpRequest(`${config.serverUrl}/api/pairing/status/${code}`);
      if (res.ok && res.data.confirmed) {
        // Guardar la clave automaticamente
        saveConfig({ ...config, machineKey: res.data.machine_key });
        startHeartbeat();
        return { confirmed: true };
      }
      return { confirmed: false };
    } catch {
      return { confirmed: false };
    }
  });

  // Tray
  tray = new Tray(createTrayIcon());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'ServerEyes', enabled: false },
    { type: 'separator' },
    { label: 'Vincular equipo', click: openPairingWindow },
    { label: 'Configuracion', click: openConfigWindow },
    { label: 'Enviar heartbeat ahora', click: sendHeartbeat },
    { type: 'separator' },
    {
      label: 'Iniciar con Windows', type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked })
    },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuiting = true; app.quit(); } }
  ]));
  tray.setToolTip('ServerEyes - Iniciando...');
  tray.on('double-click', openConfigWindow);

  startHeartbeat();
});

app.on('window-all-closed', (e) => e.preventDefault());
