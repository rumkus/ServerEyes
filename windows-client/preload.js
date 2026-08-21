// Puente entre las ventanas (config.html, pairing.html) y el proceso principal.
//
// Las ventanas corren con contextIsolation: true y nodeIntegration: false, asi
// que no tienen require ni acceso a Node. Todo lo que pueden hacer es llamar a
// estas cinco funciones, que son exactamente los canales IPC que ya existian.
// Antes, cualquier inyeccion de HTML en esas pantallas equivalia a ejecucion de
// codigo con los permisos del usuario.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serverEyes', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  testConnection: () => ipcRenderer.invoke('test-connection'),
  requestPairing: () => ipcRenderer.invoke('request-pairing'),
  checkPairing: (code) => ipcRenderer.invoke('check-pairing', code)
});
