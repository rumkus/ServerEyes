const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const os = require('os');
const Store = require('electron-store');
const fetch = require('node-fetch');

const store = new Store();

let tray = null;
let configWindow = null;
let heartbeatInterval = null;

// Configuracion por defecto
const DEFAULT_CONFIG = {
  serverUrl: '',
  machineKey: '',
  machineName: os.hostname(),
  heartbeatInterval: 30 // segundos
};

function getConfig() {
  return {
    serverUrl: store.get('serverUrl', DEFAULT_CONFIG.serverUrl),
    machineKey: store.get('machineKey', DEFAULT_CONFIG.machineKey),
    machineName: store.get('machineName', DEFAULT_CONFIG.machineName),
    heartbeatInterval: store.get('heartbeatInterval', DEFAULT_CONFIG.heartbeatInterval)
  };
}

// Obtener IP publica
async function getPublicIP() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    return data.ip;
  } catch (error) {
    console.error('Error obteniendo IP publica:', error.message);
    return null;
  }
}

// Obtener IP local
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Obtener info del sistema
function getOSInfo() {
  return `${os.type()} ${os.release()} | ${os.cpus()[0]?.model || 'Unknown'} | RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`;
}

// Enviar heartbeat
async function sendHeartbeat() {
  const config = getConfig();

  if (!config.serverUrl || !config.machineKey) {
    updateTrayIcon('unconfigured');
    return;
  }

  try {
    const publicIP = await getPublicIP();
    const localIP = getLocalIP();
    const osInfo = getOSInfo();

    const response = await fetch(`${config.serverUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_key: config.machineKey,
        machine_name: config.machineName,
        public_ip: publicIP,
        local_ip: localIP,
        os_info: osInfo
      }),
      timeout: 10000
    });

    if (response.ok) {
      updateTrayIcon('online');
    } else {
      const err = await response.json();
      console.error('Error heartbeat:', err);
      updateTrayIcon('error');
    }
  } catch (error) {
    console.error('Error enviando heartbeat:', error.message);
    updateTrayIcon('offline');
  }
}

// Actualizar icono del tray segun estado
function updateTrayIcon(status) {
  if (!tray) return;

  const statusText = {
    online: 'ServerEyes - Conectado',
    offline: 'ServerEyes - Sin conexion al servidor',
    error: 'ServerEyes - Error de configuracion',
    unconfigured: 'ServerEyes - No configurado'
  };

  tray.setToolTip(statusText[status] || 'ServerEyes');
}

// Crear icono para el tray (generado programaticamente)
function createTrayIcon() {
  // Crear un icono simple de 16x16
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA4ElEQVQ4T2NkoBAwUqifYdAY8J+B4T8jNa3+z8DAyIAUBv8ZGP4zMTL+Z2Jm+s/EzPyfmYXpPzML83/m/8z/WdhY/7OwsvxnZWP9z8rO+p+Ng+0/Gyfbf3ZO9v8cXBz/Obg5/nPycP7n4uX6z83H/Z+Hn+c/Lz/vfz4B/gL8/wUEBf4LCRH+FxYR/i8iI/JfVE70v5i8+H8JRYn/kkqS/6VUZP7Lqsn+l9eQ/6+gqfBfUUvxv5K2MliNsp7Kf1UD1f9qhmr/1Y3U/2sYa/zXNNH8r2Wq9V/bTBsAI3VQEQ6jJLIAAAAASUVORK5CYII='
  );
  return icon;
}

// Ventana de configuracion
function openConfigWindow() {
  if (configWindow) {
    configWindow.focus();
    return;
  }

  configWindow = new BrowserWindow({
    width: 480,
    height: 520,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: 'ServerEyes - Configuracion',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  configWindow.setMenuBarVisibility(false);
  configWindow.loadFile(path.join(__dirname, 'config.html'));

  configWindow.on('closed', () => {
    configWindow = null;
  });
}

// IPC handlers
ipcMain.handle('get-config', () => getConfig());

ipcMain.handle('save-config', (event, config) => {
  store.set('serverUrl', config.serverUrl);
  store.set('machineKey', config.machineKey);
  store.set('machineName', config.machineName);
  store.set('heartbeatInterval', config.heartbeatInterval);

  // Reiniciar heartbeat con nueva config
  startHeartbeat();

  return { success: true };
});

ipcMain.handle('test-connection', async () => {
  const config = getConfig();
  if (!config.serverUrl) return { success: false, message: 'URL del servidor no configurada' };

  try {
    const response = await fetch(`${config.serverUrl}/api/status`);
    if (response.ok) {
      return { success: true, message: 'Conexion exitosa' };
    }
    return { success: false, message: 'El servidor no responde correctamente' };
  } catch (error) {
    return { success: false, message: `Error: ${error.message}` };
  }
});

// Iniciar/reiniciar heartbeat
function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  const config = getConfig();
  const interval = (config.heartbeatInterval || 30) * 1000;

  // Enviar primer heartbeat inmediatamente
  sendHeartbeat();

  // Luego cada X segundos
  heartbeatInterval = setInterval(sendHeartbeat, interval);
}

// App ready
app.whenReady().then(() => {
  // Ocultar de la barra de tareas
  app.dock?.hide?.();

  // Crear tray
  const icon = createTrayIcon();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'ServerEyes', enabled: false },
    { type: 'separator' },
    {
      label: 'Configuracion',
      click: openConfigWindow
    },
    {
      label: 'Enviar heartbeat ahora',
      click: sendHeartbeat
    },
    { type: 'separator' },
    {
      label: 'Iniciar con Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      }
    },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip('ServerEyes - Iniciando...');

  tray.on('double-click', openConfigWindow);

  // Iniciar heartbeat
  startHeartbeat();
});

// Evitar que la app se cierre al cerrar la ventana
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

// Single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openConfigWindow();
  });
}
