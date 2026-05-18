const electron = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain } = electron;

let tray = null;
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

// Metricas del sistema (CPU, RAM, Disco)
function getSystemMetrics() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    // CPU usage via wmic
    exec('wmic cpu get loadpercentage /value', (err, cpuOut) => {
      let cpuUsage = null;
      if (!err) {
        const match = cpuOut.match(/LoadPercentage=(\d+)/);
        if (match) cpuUsage = parseInt(match[1]);
      }

      // RAM
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const ramTotal = Math.round(totalMem / 1024 / 1024 / 1024 * 10) / 10;
      const ramUsage = Math.round((totalMem - freeMem) / 1024 / 1024 / 1024 * 10) / 10;

      // Disco (unidad C:)
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
        ...metrics
      })
    });

    if (tray) tray.setToolTip(res.ok ? `ServerEyes - Conectado (${publicIP}) - ${pingMs || '?'}ms` : 'ServerEyes - Error');

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
