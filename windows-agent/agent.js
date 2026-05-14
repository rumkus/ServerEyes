const https = require('https');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Config
const CONFIG_FILE = path.join(path.dirname(process.execPath), 'servereyes-config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return { serverUrl: '', machineKey: '', machineName: os.hostname(), heartbeatInterval: 30 };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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

// IPs activas (sin virtuales, sin link-local)
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
        machine_key: config.machineKey,
        machine_name: config.machineName,
        public_ip: publicIP,
        local_ip: getLocalIP(),
        os_info: getOSInfo()
      })
    });
    const ts = new Date().toLocaleTimeString();
    if (res.ok) console.log(`[${ts}] Heartbeat OK - IP: ${publicIP}`);
    else console.log(`[${ts}] Heartbeat ERROR: ${JSON.stringify(res.data)}`);
  } catch (err) {
    console.log(`[${new Date().toLocaleTimeString()}] Heartbeat FAILED: ${err.message}`);
  }
}

// Pairing
async function startPairing(config, rl) {
  console.log('\n--- Vincular equipo ---');
  try {
    const res = await httpRequest(`${config.serverUrl}/api/pairing/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine_name: config.machineName, os_info: getOSInfo() })
    });

    if (!res.ok) { console.log('Error:', res.data.error); return; }

    console.log(`\n  CODIGO: ${res.data.code}\n`);
    console.log('  Ingresa este codigo en la app del celular.');
    console.log('  Esperando confirmacion (5 min max)...\n');

    // Poll cada 2s
    const poll = setInterval(async () => {
      try {
        const check = await httpRequest(`${config.serverUrl}/api/pairing/status/${res.data.code}`);
        if (check.ok && check.data.confirmed) {
          clearInterval(poll);
          config.machineKey = check.data.machine_key;
          saveConfig(config);
          console.log('  ¡VINCULADO! La clave se guardo automaticamente.\n');
        }
      } catch {}
    }, 2000);

    // Timeout 5 min
    setTimeout(() => clearInterval(poll), 5 * 60 * 1000);
  } catch (err) {
    console.log('Error:', err.message);
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

  console.log('\n¿Como queres vincular?');
  console.log('  1) Codigo de vinculacion (desde la app del celular)');
  console.log('  2) Ingresar clave manualmente');
  const choice = await ask('\nOpcion [1]: ');

  if (choice.trim() === '2') {
    const key = await ask('Clave de maquina: ');
    if (key.trim()) config.machineKey = key.trim();
  } else {
    saveConfig(config);
    await startPairing(config, rl);
  }

  saveConfig(config);
  rl.close();
}

// Main
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--setup') || args.includes('-s')) {
    await setup();
    return;
  }

  const config = loadConfig();

  if (!config.serverUrl || !config.machineKey) {
    console.log('ServerEyes Agent - No configurado');
    console.log('Ejecuta con --setup para configurar');
    console.log(`  ${process.execPath} --setup`);
    console.log(`\nO edita: ${CONFIG_FILE}`);
    return;
  }

  console.log(`ServerEyes Agent v1.0`);
  console.log(`Maquina: ${config.machineName}`);
  console.log(`Servidor: ${config.serverUrl}`);
  console.log(`Intervalo: ${config.heartbeatInterval}s`);
  console.log(`Config: ${CONFIG_FILE}`);
  console.log('---');

  // Primer heartbeat
  await sendHeartbeat(config);

  // Loop
  setInterval(() => sendHeartbeat(config), (config.heartbeatInterval || 30) * 1000);
}

main().catch(console.error);
