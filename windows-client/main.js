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

// Obtener IP local
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// Info del sistema
function getOSInfo() {
  return `${os.type()} ${os.release()} | ${os.cpus()[0]?.model || 'Unknown'} | RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`;
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
    const res = await httpRequest(`${config.serverUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_key: config.machineKey,
        machine_name: config.machineName,
        public_ip: publicIP,
        local_ip: getLocalIP(),
        os_info: getOSInfo()
      })
    });

    if (tray) tray.setToolTip(res.ok ? `ServerEyes - Conectado (${publicIP})` : 'ServerEyes - Error');
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

  // Tray
  tray = new Tray(createTrayIcon());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'ServerEyes', enabled: false },
    { type: 'separator' },
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
