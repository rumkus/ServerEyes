const https = require('https');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const { spawn } = require('child_process');

const AGENT_VERSION = '1.3.5';
const EXE_PATH = process.execPath;
const EXE_DIR = path.dirname(EXE_PATH);
const CONFIG_FILE = path.join(EXE_DIR, 'servereyes-config.json');
const LOG_FILE = path.join(EXE_DIR, 'servereyes.log');
const VBS_FILE = path.join(EXE_DIR, 'ServerEyes-Silent.vbs');
const WATCHDOG_FILE = path.join(EXE_DIR, 'ServerEyes-Watchdog.vbs');
// Mientras existe esta bandera el watchdog no levanta nada. Es lo que evita que
// relance el binario viejo justo cuando el update esta moviendo los archivos.
const FLAG_UPDATE = path.join(EXE_DIR, 'servereyes-actualizando.flag');
const TASK_NAME = 'ServerEyes Agent';

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return { serverUrl: '', machineKey: '', machineName: os.hostname(), heartbeatInterval: 30 };
}

// El dominio propio reemplazo al de Railway, pero las maquinas que ya tenian el
// agente instalado siguen con la URL vieja en su servereyes-config.json, que se
// guardo en el disco de cada una. Recompilar el .exe no las toca: hay que
// reescribirla al arrancar. Las dos apuntan al mismo servicio, asi que el
// cambio es transparente.
const URL_VIEJA = 'https://servereyes-production.up.railway.app';
const URL_NUEVA = 'https://servereyes.app';

// Un update puede "aplicarse" y dejar corriendo la misma version de antes: el
// bat renombra y mueve archivos, y si algo de eso falla nadie se entera. Sin
// freno, el agente vuelve a bajar el mismo binario cada minuto para siempre.
// Paso de verdad en esta instalacion: 168 intentos seguidos con la v1.0.0, 163
// con la v1.1.0 y 23 con la v1.0.7, bajando 36MB cada vez.
//
// El contador va al archivo de configuracion porque el proceso se reinicia en
// cada vuelta: en memoria se perderia y el bucle seguiria igual.
const MAX_INTENTOS_UPDATE = 3;

function intentosDeUpdate(config, version) {
  const registro = config.updateIntentos || {};
  return registro[version] || 0;
}

function anotarIntentoUpdate(config, version) {
  // Solo se guarda la version que se esta intentando: si aparece una nueva, la
  // anterior deja de importar y el archivo no crece.
  config.updateIntentos = { [version]: intentosDeUpdate(config, version) + 1 };
  saveConfig(config);
}

function limpiarIntentosUpdate(config) {
  if (!config.updateIntentos) return;
  delete config.updateIntentos;
  saveConfig(config);
}

function migrarUrlServidor(config) {
  if (config.serverUrl !== URL_VIEJA) return false;
  config.serverUrl = URL_NUEVA;
  saveConfig(config);
  log(`Servidor actualizado al dominio propio: ${URL_NUEVA}`);
  return true;
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

// Servicios Windows importantes
// Windows Backup status
let _backupCache = null;
let _backupLastCheck = 0;
const BACKUP_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

function formatBackupDate(raw) {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  } catch { return raw; }
}

function getBackupStatus(forceCheck) {
  if (!forceCheck && _backupCache && (Date.now() - _backupLastCheck) < BACKUP_CHECK_INTERVAL) {
    return Promise.resolve(_backupCache);
  }
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    // Leer ultimos 3 eventos de Windows Backup para tener mas contexto
    exec('wevtutil qe Microsoft-Windows-Backup /c:3 /rd:true /f:text 2>nul', { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (!err && stdout && stdout.includes('Event')) {
        // Parsear el primer evento (mas reciente)
        const dateMatch = stdout.match(/Date:\s*(.+)/i) || stdout.match(/Fecha:\s*(.+)/i);
        const levelMatch = stdout.match(/Level:\s*(.+)/i) || stdout.match(/Nivel:\s*(.+)/i);
        const msgMatch = stdout.match(/Message:\s*([\s\S]*?)(?:\n\n|\nEvent|\n$)/i) || stdout.match(/Mensaje:\s*([\s\S]*?)(?:\n\n|\nEvent|\n$)/i);
        const level = levelMatch ? levelMatch[1].trim().toLowerCase() : '';
        const message = msgMatch ? msgMatch[1].trim().substring(0, 300) : '';

        let status = 'ok';
        let statusText = 'Backup realizado con exito';
        if (level.includes('error') || level.includes('critical')) {
          status = 'error';
          statusText = 'El backup fallo';
        } else if (level.includes('warning') || level.includes('advertencia')) {
          status = 'warning';
          statusText = 'Backup con advertencias';
        }

        _backupCache = {
          status,
          status_text: statusText,
          last_backup: dateMatch ? formatBackupDate(dateMatch[1].trim()) : null,
          message: message || null,
          checked_at: new Date().toLocaleString()
        };
        _backupLastCheck = Date.now();
        resolve(_backupCache);
        return;
      }
      // No hay eventos de backup - chequear si el servicio existe
      exec('sc query wbengine 2>nul', { timeout: 5000, windowsHide: true }, (err2, stdout2) => {
        if (!err2 && stdout2 && stdout2.includes('wbengine')) {
          // Servicio existe pero no hay eventos - nunca se ejecuto
          _backupCache = { status: 'never', status_text: 'Backup configurado pero nunca ejecutado', checked_at: new Date().toLocaleString() };
        } else {
          // Chequear carpeta
          exec('dir /b /od "C:\\WindowsImageBackup" 2>nul', { timeout: 5000, windowsHide: true }, (err3, stdout3) => {
            if (!err3 && stdout3 && stdout3.trim()) {
              _backupCache = { status: 'ok', status_text: 'Backup realizado con exito', last_backup: stdout3.trim().split('\n').pop()?.trim(), checked_at: new Date().toLocaleString() };
            } else {
              _backupCache = { status: 'not_configured', status_text: 'Windows Backup no esta configurado', checked_at: new Date().toLocaleString() };
            }
            _backupLastCheck = Date.now();
            resolve(_backupCache);
          });
          return;
        }
        _backupLastCheck = Date.now();
        resolve(_backupCache);
      });
    });
  });
}

function getServices() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    // Listar servicios conocidos: IIS, SQL Server, MySQL, PostgreSQL, Apache, DHCP, DNS, Print Spooler, RDP, etc.
    const knownServices = 'W3SVC,MSSQLSERVER,MSSQL$*,MySQL*,postgresql*,Apache*,DHCPServer,DNS,Spooler,TermService,WinRM,MSDTC,SQLBrowser,W32Time,EventLog,LanmanServer,Netlogon';
    exec('sc query type= service state= all', { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const services = [];
      if (!err && stdout) {
        const blocks = stdout.split('SERVICE_NAME:').filter(Boolean);
        for (const block of blocks) {
          const nameLine = block.trim().split('\n')[0].trim();
          const stateMatch = block.match(/STATE\s+:\s+\d+\s+(\w+)/);
          const displayMatch = block.match(/DISPLAY_NAME\s*:\s*(.+)/);
          if (nameLine && stateMatch) {
            const svcName = nameLine;
            const state = stateMatch[1];
            const display = displayMatch ? displayMatch[1].trim() : svcName;
            // Filtrar solo servicios interesantes
            const isKnown = knownServices.split(',').some(k => {
              if (k.endsWith('*')) return svcName.toUpperCase().startsWith(k.slice(0, -1).toUpperCase());
              return svcName.toUpperCase() === k.toUpperCase();
            });
            if (isKnown) {
              services.push({ name: svcName, display, state });
            }
          }
        }
      }
      resolve(services.length > 0 ? services : null);
    });
  });
}

// Puertos abiertos (TCP LISTENING)
function getOpenPorts() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec('netstat -an -p TCP | findstr LISTENING', { timeout: 10000, windowsHide: true }, (err, stdout) => {
      const ports = [];
      if (!err && stdout) {
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const match = line.match(/:(\d+)\s/);
          if (match) {
            const port = parseInt(match[1]);
            if (port > 0 && !ports.includes(port)) ports.push(port);
          }
        }
        ports.sort((a, b) => a - b);
      }
      resolve(ports.length > 0 ? ports : null);
    });
  });
}

// Windows Update info
function getWindowsUpdateInfo() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const cmd = `powershell -NoProfile -Command "try { $s = New-Object -ComObject Microsoft.Update.AutoUpdate; $r = $s.Results; $last = $r.LastInstallationSuccessDate; $pending = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search('IsInstalled=0').Updates.Count; @{last_install = if($last){$last.ToString('yyyy-MM-dd HH:mm')}else{'never'}; pending = $pending} | ConvertTo-Json } catch { @{error=$_.Exception.Message} | ConvertTo-Json }"`;
    exec(cmd, { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
    });
  });
}

// Office info
function getOfficeInfo() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const cmd = `powershell -NoProfile -Command "try { $paths = @('HKLM:\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration','HKLM:\\SOFTWARE\\Microsoft\\Office\\16.0\\Common\\InstallRoot'); $ver = $null; $prod = $null; try { $c2r = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration' -EA Stop; $ver = $c2r.VersionToReport; $prod = $c2r.ProductReleaseIds } catch {}; if(!$ver){ try { $ver = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Office\\16.0\\Common\\InstallRoot' -EA Stop).Path } catch {} }; @{version=$ver;product=$prod;installed=($ver -ne $null)} | ConvertTo-Json } catch { @{installed=$false} | ConvertTo-Json }"`;
    exec(cmd, { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve({ installed: false }); return; }
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve({ installed: false }); }
    });
  });
}

// Antivirus info
function getAntivirusInfo() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const cmd = `powershell -NoProfile -Command "try { $av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -EA Stop | Select displayName,productState,timestamp | ForEach-Object { $state = $_.productState; $enabled = (($state -band 0x1000) -ne 0); $upToDate = (($state -band 0x10) -eq 0); @{name=$_.displayName;enabled=$enabled;up_to_date=$upToDate;raw_state=$state;timestamp=$_.timestamp} }; $av | ConvertTo-Json } catch { @{error=$_.Exception.Message} | ConvertTo-Json }"`;
    exec(cmd, { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try {
        const data = JSON.parse(stdout.trim());
        resolve(Array.isArray(data) ? data : [data]);
      } catch { resolve(null); }
    });
  });
}

// ── INVENTARIO ──
//
// Todo lo que hace falta para armar el inventario de un cliente: hardware, red,
// proxy, archivo hosts, y si se le puede agregar memoria.
//
// Va en PowerShell con CIM y no con wmic porque Microsoft saco wmic de Windows
// 11 24H2 en adelante. Se manda por -EncodedCommand (base64 UTF-16LE) para no
// pelear con el escapeo de comillas de cmd, que con un script de este largo es
// imposible de mantener.
// Con String.raw y no con un template literal comun: adentro hay regex de
// PowerShell (\s, \d) y la ruta \System32\drivers\etc\hosts. Un template
// normal se come las barras invertidas y PowerShell recibe "s+" en vez de
// "\s+" y una ruta sin separadores, sin fallar: simplemente no encuentra nada.
const INVENTARIO_PS = String.raw`# Inventario de la maquina para ServerEyes. Devuelve un JSON por stdout.
#
# Usa CIM y no wmic: Microsoft saco wmic de Windows 11 24H2 en adelante, asi que
# el codigo viejo del agente va a dejar de funcionar en maquinas nuevas.
# Todo va envuelto en try/catch por campo: una maquina sin un dato (por ejemplo
# sin Get-PhysicalDisk en Windows 7) tiene que devolver el resto igual.

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Intentar($bloque) { try { & $bloque } catch { $null } }
# Igual que Intentar pero garantizando un array. El operador & desarma las
# colecciones: con un solo elemento vuelve el objeto suelto, y pedirle .Count a
# un CimInstance devuelve $null (busca una propiedad CIM llamada Count, que no
# existe) en vez de 1. Sin esto, toda maquina con un solo modulo de memoria o
# un solo disco se iba por la rama de "no hay datos".
function IntentarLista($bloque) { $r = try { & $bloque } catch { $null }; return @($r | Where-Object { $_ -ne $null }) }

$inv = [ordered]@{}
$inv.recolectado = (Get-Date).ToString('o')

# ── Identidad ───────────────────────────────────────────────────────────────
$cs = Intentar { Get-CimInstance Win32_ComputerSystem }
$os = Intentar { Get-CimInstance Win32_OperatingSystem }
$inv.hostname   = $env:COMPUTERNAME
$inv.so         = if ($os) { $os.Caption } else { $null }
$inv.so_version = if ($os) { $os.Version } else { $null }
$inv.so_arch    = if ($os) { $os.OSArchitecture } else { $null }
# Usuario logueado ahora; si no hay sesion interactiva, el ultimo que se conocio
$inv.usuario    = if ($cs -and $cs.UserName) { $cs.UserName } else { $env:USERNAME }
$inv.en_dominio = if ($cs) { [bool]$cs.PartOfDomain } else { $null }
$inv.dominio    = if ($cs) { $cs.Domain } else { $null }
$inv.grupo_trabajo = if ($cs -and -not $cs.PartOfDomain) { $cs.Workgroup } else { $null }
$inv.fabricante = if ($cs) { $cs.Manufacturer } else { $null }
$inv.modelo     = if ($cs) { $cs.Model } else { $null }
$bios = Intentar { Get-CimInstance Win32_BIOS }
$inv.serie      = if ($bios) { $bios.SerialNumber } else { $null }

# ── CPU ─────────────────────────────────────────────────────────────────────
$cpu = Intentar { Get-CimInstance Win32_Processor | Select-Object -First 1 }
if ($cpu) {
  $inv.cpu         = $cpu.Name.Trim()
  $inv.cpu_nucleos = $cpu.NumberOfCores
  $inv.cpu_hilos   = $cpu.NumberOfLogicalProcessors
  $inv.cpu_mhz     = $cpu.MaxClockSpeed
  # Generacion: Intel Core i5-8250U -> 8va; Ryzen 5 5600X -> serie 5000
  $gen = $null
  if ($cpu.Name -match 'Ultra\s+\d+\s+(\d)\d{2}') {
    # Los Core Ultra no siguen el formato i7-8750H: "Ultra 7 265KF" es serie 2,
    # "Ultra 7 155H" es serie 1.
    $gen = "Core Ultra serie $($matches[1])"
  } elseif ($cpu.Name -match '[im]\d[- ](\d{4,5})') {
    $n = $matches[1]
    $gen = if ($n.Length -eq 5) { "$($n.Substring(0,2))a generacion" } else { "$($n.Substring(0,1))a generacion" }
  } elseif ($cpu.Name -match 'Ryzen\s+\d\s+(\d)\d{3}') {
    $gen = "serie $($matches[1])000"
  }
  $inv.cpu_generacion = $gen
}

# ── Memoria ─────────────────────────────────────────────────────────────────
$tipos = @{
  20='DDR'; 21='DDR2'; 22='DDR2 FB-DIMM'; 24='DDR3'; 26='DDR4'; 34='DDR5';
  17='SDRAM'; 18='SDRAM'; 19='RDRAM'; 25='FBD2'; 27='DDR4'; 28='LPDDR'; 29='LPDDR2'; 30='LPDDR3'; 31='LPDDR4'; 35='LPDDR5'
}
$modulos = @(IntentarLista { Get-CimInstance Win32_PhysicalMemory })
$arreglo = @(IntentarLista { Get-CimInstance Win32_PhysicalMemoryArray })
$inv.ram_gb = if ($cs) { [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) } else { $null }
$inv.ram_modulos = @()
foreach ($m in $modulos) {
  $t = $tipos[[int]$m.SMBIOSMemoryType]
  if (-not $t) { $t = $tipos[[int]$m.MemoryType] }
  $inv.ram_modulos += [ordered]@{
    banco = $m.DeviceLocator; gb = [math]::Round($m.Capacity / 1GB, 1)
    tipo = $t; mhz = $m.Speed; fabricante = ($m.Manufacturer -replace '\s+$','')
  }
}
# Slots: MemoryDevices del arreglo fisico es el total de zocalos de la placa
$slotsTotal = if ($arreglo -and $arreglo.Count -gt 0) { ($arreglo | Measure-Object -Property MemoryDevices -Sum).Sum } else { $null }
$inv.ram_slots_total = $slotsTotal
$inv.ram_slots_usados = $modulos.Count
$inv.ram_slots_libres = if ($slotsTotal) { $slotsTotal - $modulos.Count } else { $null }
$inv.ram_tipo = ($inv.ram_modulos | ForEach-Object { $_.tipo } | Where-Object { $_ } | Select-Object -Unique) -join '/'
$inv.ram_ampliable = if ($slotsTotal) { ($slotsTotal - $modulos.Count) -gt 0 } else { $null }
$inv.ram_max_gb = if ($arreglo -and $arreglo.Count -gt 0) {
  $k = ($arreglo | Measure-Object -Property MaxCapacityEx -Sum).Sum
  if ($k -gt 0) { [math]::Round($k / 1MB, 0) } else { $null }
} else { $null }

# ── Discos fisicos: tamaño y si es solido o mecanico ────────────────────────
$inv.discos = @()
$fisicos = @(IntentarLista { Get-PhysicalDisk })
if ($fisicos -and $fisicos.Count -gt 0) {
  foreach ($d in $fisicos) {
    $medio = switch ("$($d.MediaType)") {
      'SSD' { 'Solido (SSD)' } 'HDD' { 'Mecanico (HDD)' } 'SCM' { 'Memoria persistente' } default { $null }
    }
    if (-not $medio -and $d.SpindleSpeed -eq 0) { $medio = 'Solido (SSD)' }
    $inv.discos += [ordered]@{
      modelo = $d.FriendlyName; gb = [math]::Round($d.Size / 1GB, 1)
      tipo = $medio; bus = "$($d.BusType)"; salud = "$($d.HealthStatus)"
    }
  }
} else {
  # Windows viejo sin Get-PhysicalDisk
  foreach ($d in (IntentarLista { Get-CimInstance Win32_DiskDrive })) {
    $inv.discos += [ordered]@{ modelo = $d.Model; gb = [math]::Round($d.Size / 1GB, 1); tipo = $null; bus = $d.InterfaceType; salud = $null }
  }
}

# ── Volumenes (lo que ve el usuario: C:, D:, ...) ───────────────────────────
$inv.volumenes = @()
foreach ($v in (IntentarLista { Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' })) {
  $inv.volumenes += [ordered]@{
    letra = $v.DeviceID; etiqueta = $v.VolumeName
    gb = [math]::Round($v.Size / 1GB, 1); libre_gb = [math]::Round($v.FreeSpace / 1GB, 1)
  }
}

# ── Red: solo las placas que realmente transmiten ───────────────────────────
# Se piden las que estan Up y con IP; las virtuales (Hyper-V, VMware, VPN) y las
# desconectadas no entran, que es lo que se pidio.
$inv.placas = @()
$adaptadores = @(IntentarLista { Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } })
if (-not $adaptadores -or $adaptadores.Count -eq 0) {
  $adaptadores = @(IntentarLista { Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.Virtual -eq $false } })
}
# Nombres que Windows presenta como fisicos pero no llevan trafico real
$falsas = 'bucle invertido|loopback|KM-TEST|Hyper-V|VMware|VirtualBox|VPN|TAP-|Bluetooth|Npcap|WAN Miniport'
foreach ($a in $adaptadores) {
  if ("$($a.InterfaceDescription) $($a.Name)" -match $falsas) { continue }
  $cfg  = Intentar { Get-NetIPConfiguration -InterfaceIndex $a.ifIndex }
  $ipv4 = Intentar { Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 | Select-Object -First 1 }
  $dns  = IntentarLista { (Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4).ServerAddresses }
  $dhcp = Intentar { (Get-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4).Dhcp }
  # Sin IP util (APIPA de 169.254 o directamente ninguna) no esta transmitiendo
  if (-not $ipv4 -or $ipv4.IPAddress -like '169.254.*') { continue }
  $inv.placas += [ordered]@{
    nombre = $a.Name; descripcion = $a.InterfaceDescription; mac = $a.MacAddress
    velocidad = "$($a.LinkSpeed)"
    ip = if ($ipv4) { $ipv4.IPAddress } else { $null }
    mascara = if ($ipv4) { $ipv4.PrefixLength } else { $null }
    gateway = if ($cfg -and $cfg.IPv4DefaultGateway) { $cfg.IPv4DefaultGateway.NextHop } else { $null }
    dns = @($dns)
    # PrefixOrigin Dhcp es mas confiable que el flag de la interfaz
    dhcp = if ($ipv4) { $ipv4.PrefixOrigin -eq 'Dhcp' } elseif ($dhcp) { "$dhcp" -eq 'Enabled' } else { $null }
  }
}
$conGw = $inv.placas | Where-Object { $_.gateway } | Select-Object -First 1
if (-not $conGw) { $conGw = $inv.placas | Select-Object -First 1 }
if ($conGw) {
  $inv.ip_interna = $conGw.ip
  $inv.gateway    = $conGw.gateway
  $inv.dns        = $conGw.dns
  $inv.dhcp       = $conGw.dhcp
  $inv.mac        = $conGw.mac
}

# ── Proxy ───────────────────────────────────────────────────────────────────
$proxy = [ordered]@{ configurado = $false; servidor = $null; excepciones = $null; automatico = $null; winhttp = $null }
$reg = Intentar { Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' }
if ($reg) {
  $proxy.configurado = [bool]$reg.ProxyEnable
  $proxy.servidor    = $reg.ProxyServer
  $proxy.excepciones = $reg.ProxyOverride
  $proxy.automatico  = $reg.AutoConfigURL
}
# El proxy de sistema (servicios, no la sesion del usuario)
$wh = Intentar { netsh winhttp show proxy 2>$null | Out-String }
if ($wh) {
  $proxy.winhttp = if ($wh -match 'Acceso directo|Direct access') { 'directo' } else { ($wh -split ([char]10) | Where-Object { $_ -match ':' } | Select-Object -Last 2) -join ' ' }
}
$inv.proxy = $proxy

# ── Archivo hosts con entradas cargadas ─────────────────────────────────────
$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$entradas = @()
if (Test-Path $hostsPath) {
  foreach ($l in (Get-Content $hostsPath)) {
    $t = $l.Trim()
    if ($t -and -not $t.StartsWith('#')) { $entradas += $t -replace '\s+', ' ' }
  }
}
$inv.hosts_entradas = $entradas
$inv.hosts_tiene_entradas = $entradas.Count -gt 0

$inv | ConvertTo-Json -Depth 6 -Compress
`;

// Windows 10 / Server 2016 son la version 10.x. Todo lo anterior (6.3 es
// Server 2012 R2, 6.1 es 2008 R2) queda afuera del relevamiento: ahi el agente
// se comporta exactamente como antes de esta funcion. Node 18 declara esos
// Windows como soporte experimental, asi que no vale la pena arriesgar el
// monitoreo de un servidor por un dato de inventario.
function windowsSoportaInventario() {
  const mayor = parseInt(String(require('os').release()).split('.')[0], 10);
  return Number.isFinite(mayor) && mayor >= 10;
}

function getInventario() {
  return new Promise((resolve) => {
    if (!windowsSoportaInventario()) {
      log(`Inventario omitido: Windows ${require('os').release()} es anterior a Windows 10 / Server 2016`);
      resolve(null);
      return;
    }
    const { spawn } = require('child_process');
    // El script va por stdin y no por -Command ni -EncodedCommand: la linea de
    // comandos de Windows corta en ~8191 caracteres, y este script en base64
    // UTF-16 pasa los 19000. Por stdin no hay limite y no quedan archivos
    // temporales dando vueltas en el disco del cliente.
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'],
      { windowsHide: true });
    let salida = '', errores = '';
    let listo = false;
    const terminar = (v) => { if (listo) return; listo = true; clearTimeout(cortar); resolve(v); };
    const cortar = setTimeout(() => { try { ps.kill(); } catch {} terminar(null); }, 90000);
    // Sin este manejador, si PowerShell no esta o muere antes de leer, el EPIPE
    // se emite como 'error' sin escuchar y se lleva puesto al agente entero.
    ps.stdin.on('error', (e) => { log('Inventario: no se pudo enviar el script: ' + e.message); terminar(null); });
    ps.stdout.on('data', d => { salida += d; });
    ps.stderr.on('data', d => { errores += d; });
    ps.on('error', e => { log('Inventario: no se pudo lanzar PowerShell: ' + e.message); terminar(null); });
    ps.on('close', () => {
      const texto = salida.trim();
      if (!texto) { log('Inventario: sin respuesta' + (errores ? ': ' + errores.trim().slice(0, 200) : '')); terminar(null); return; }
      try {
        const datos = JSON.parse(texto);
        terminar(datos && datos.hostname ? datos : null);
      } catch (e) {
        log('Inventario: respuesta ilegible: ' + e.message);
        terminar(null);
      }
    });
    try {
      ps.stdin.write(INVENTARIO_PS);
      ps.stdin.end();
    } catch (e) {
      log('Inventario: fallo al escribir el script: ' + e.message);
      terminar(null);
    }
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


// ── Verificacion de origen ───────────────────────────────────────────────────
// El servidor firma comandos y updates con HMAC-SHA256 usando la machine_key,
// que solo conocemos nosotros y el. Sin esto, cualquiera que consiga responder
// en lugar del servidor (DNS secuestrado, proxy, un server falso apuntado por
// una config alterada) nos hace ejecutar lo que quiera.
function firmaEsperada(machineKey, ...partes) {
  return require('crypto').createHmac('sha256', String(machineKey))
    .update(partes.join('\u0000')).digest('hex');
}
function firmaValida(recibida, esperada) {
  if (!recibida || typeof recibida !== 'string' || recibida.length !== esperada.length) return false;
  // Comparacion de tiempo constante
  return require('crypto').timingSafeEqual(Buffer.from(recibida, 'utf8'), Buffer.from(esperada, 'utf8'));
}

// Auto-update: descarga nuevo exe, renombra viejo, pone nuevo en su lugar
async function selfUpdate(url, newVersion, config, sha256Esperado) {
  const newPath = path.join(EXE_DIR, 'servereyes-new.exe');
  const oldPath = path.join(EXE_DIR, 'servereyes-old.exe');
  const batPath = path.join(EXE_DIR, 'servereyes-update.bat');

  log(`Descargando actualizacion v${newVersion} desde ${url}`);
  try {
    // Descargar archivo: solo https, tambien en los redirects. Un salto a http
    // permitiria sustituir el binario en transito.
    await new Promise((resolve, reject) => {
      const downloadFile = (downloadUrl, redirects) => {
        if (redirects > 5) { reject(new Error('Demasiados redirects')); return; }
        if (!/^https:\/\//i.test(downloadUrl)) { reject(new Error('Update rechazado: la descarga no es https -> ' + downloadUrl)); return; }
        https.get(downloadUrl, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            res.resume();
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

    // El hash lo publica el servidor junto con la version. Sin hash no
    // aplicamos nada: preferimos quedarnos en la version vieja antes que
    // ejecutar un binario que no podemos verificar.
    if (!sha256Esperado) {
      log('Update rechazado: el servidor no publico el sha256 del binario');
      try { fs.unlinkSync(newPath); } catch {}
      return;
    }
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(newPath)).digest('hex');
    if (sha.toLowerCase() !== String(sha256Esperado).toLowerCase()) {
      log(`Update rechazado: sha256 no coincide (esperado ${sha256Esperado}, bajado ${sha})`);
      try { fs.unlinkSync(newPath); } catch {}
      return;
    }

    log(`Descarga completa (${Math.round(stats.size / 1024 / 1024)}MB), hash verificado, aplicando update...`);

    // Estrategia: el bat renombra el exe actual (se puede renombrar un exe en uso),
    // mueve el nuevo al nombre original, y lo arranca.
    // El watchdog tambien ayuda a levantarlo si el bat falla.
    const exeName = path.basename(EXE_PATH);
    // La bandera frena al watchdog mientras se cambian los archivos.
    try { fs.writeFileSync(FLAG_UPDATE, new Date().toISOString()); } catch {}
    const batContent = [
      '@echo off',
      'timeout /t 3 /nobreak >nul',
      // No puede quedar ninguna instancia viva: si queda, el binario nuevo
      // arranca, ve el lock y se va, y sigue corriendo el viejo.
      `taskkill /F /IM "${exeName}" >nul 2>&1`,
      'taskkill /F /IM "servereyes-old.exe" >nul 2>&1',
      'timeout /t 2 /nobreak >nul',
      `if exist "${oldPath}" del /f /q "${oldPath}"`,
      // Windows deja renombrar un exe aunque este en uso
      `if exist "${EXE_PATH}" rename "${EXE_PATH}" servereyes-old.exe`,
      `if exist "${newPath}" move /y "${newPath}" "${EXE_PATH}"`,
      // Comprobar que lo que quedo instalado es de verdad lo que bajamos. El
      // sha256 del archivo descargado ya se verifico antes, asi que lo que se
      // esta cubriendo aca es que el rename y el move hayan salido bien: si
      // fallan a medias, sin esto arrancaria lo que haya quedado.
      //
      // certutil devuelve el hash en la segunda linea, con espacios entre bytes
      // en los Windows viejos y sin espacios en los nuevos, asi que se los saca
      // antes de comparar. El encabezado va traducido segun el idioma, por eso
      // se salta por posicion y no por texto.
      `set "esperado=${String(sha256Esperado).toLowerCase()}"`,
      'set "calculado="',
      `for /f "skip=1 delims=" %%H in ('certutil -hashfile "${EXE_PATH}" SHA256 2^>nul') do if not defined calculado set "calculado=%%H"`,
      'set "calculado=%calculado: =%"',
      // Si certutil no esta, se aplica igual: quedarse sin poder actualizar
      // nunca mas seria peor que no poder verificar esta vez.
      'if not defined calculado (',
      `  echo [update] No se pudo calcular el hash, se aplica sin verificar >> "${LOG_FILE}"`,
      ') else if /i not "%calculado%"=="%esperado%" (',
      `  echo [update] El binario instalado no coincide con el descargado, se vuelve a la version anterior >> "${LOG_FILE}"`,
      `  if exist "${EXE_PATH}" del /f /q "${EXE_PATH}"`,
      ')',
      // Si el reemplazo no quedo (o lo acabamos de descartar por el hash),
      // volver a la version anterior en vez de dejar la carpeta sin agente.
      `if not exist "${EXE_PATH}" if exist "${oldPath}" rename "${oldPath}" "${exeName}"`,
      // El lock quedo con el pid del proceso que acabamos de matar
      `if exist "${LOCK_FILE}" del /f /q "${LOCK_FILE}"`,
      `if exist "${FLAG_UPDATE}" del /f /q "${FLAG_UPDATE}"`,
      `if exist "${EXE_PATH}" start "" "${EXE_PATH}"`,
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
    try { if (fs.existsSync(FLAG_UPDATE)) fs.unlinkSync(FLAG_UPDATE); } catch {}
  }
}

let heartbeatCount = 0;
let cachedSecurityInfo = null;
// El inventario cambia muy de vez en cuando (se agrega un disco, se cambia la
// IP): recolectarlo en cada heartbeat seria tirar CPU a la basura. Se arma al
// arrancar y despues una vez por dia.
let cachedInventario = null;
let inventarioTomadoEn = 0;
const INVENTARIO_CADA = 24 * 60 * 60 * 1000;

// Heartbeat
async function sendHeartbeat(config) {
  if (!config.serverUrl || !config.machineKey) return;
  try {
    const publicIP = await getPublicIP();
    const pingMs = await measurePing();
    const metrics = await getSystemMetrics();

    // Recolectar info de seguridad cada 10 heartbeats (~5 min)
    heartbeatCount++;
    if (!cachedInventario || Date.now() - inventarioTomadoEn > INVENTARIO_CADA) {
      // El inventario es un extra: si algo sale mal, el agente tiene que seguir
      // avisando si la maquina esta viva, que es para lo que esta.
      const inv = await getInventario().catch(e => { log('Inventario: ' + e.message); return null; });
      if (inv) {
        cachedInventario = inv;
        inventarioTomadoEn = Date.now();
        log(`Inventario actualizado: ${(inv.discos || []).length} disco(s), ${(inv.placas || []).length} placa(s) de red`);
      } else {
        // Si fallo, reintentar al siguiente heartbeat y no dentro de 24 horas
        inventarioTomadoEn = 0;
      }
    }

    if (heartbeatCount >= 10 || !cachedSecurityInfo) {
      heartbeatCount = 0;
      try {
        const [wu, office, av] = await Promise.all([
          getWindowsUpdateInfo(),
          getOfficeInfo(),
          getAntivirusInfo()
        ]);
        cachedSecurityInfo = { windows_update: wu, office: office, antivirus: av };
        log(`Security info: WU=${wu?.last_install || '?'} pending=${wu?.pending || 0} Office=${office?.version || 'N/A'} AV=${av?.[0]?.name || 'N/A'}`);
      } catch (e) {
        log(`Security info error: ${e.message}`);
      }
    }

    const res = await httpRequest(`${config.serverUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_key: config.machineKey, machine_name: config.machineName,
        public_ip: publicIP, local_ip: getLocalIP(), os_info: getOSInfo(),
        ping_ms: pingMs, agent_version: AGENT_VERSION, agent_type: 'agent', agent_logs: getLastLogs(30), services: await getServices(), open_ports: await getOpenPorts(), backup_status: await getBackupStatus(false), agent_config: { machineName: config.machineName, heartbeatInterval: config.heartbeatInterval, serverUrl: config.serverUrl }, security_info: cachedSecurityInfo || null, inventory: cachedInventario || null, ...metrics
      })
    });
    if (res.ok) {
      log(`Heartbeat OK - IP: ${publicIP} - Ping: ${pingMs || '?'}ms - v${AGENT_VERSION}`);

      // Chequear si hay actualizacion disponible
      if (res.data && res.data.update && res.data.update.url) {
        const up = res.data.update;
        const esperada = firmaEsperada(config.machineKey, 'update', up.version, up.url, up.sha256 || '');
        if (!firmaValida(up.sig, esperada)) {
          log(`Update IGNORADO: firma invalida para v${up.version} (${up.url})`);
        } else {
          const yaIntentado = intentosDeUpdate(config, up.version);
          if (yaIntentado >= MAX_INTENTOS_UPDATE) {
            // Una sola linea por vuelta y nada de red: el agente sigue haciendo
            // su trabajo y el problema queda visible en el log en vez de
            // esconderse detras de miles de reintentos.
            log(`Update a v${up.version} DESISTIDO: se intento ${yaIntentado} veces y el agente sigue en v${AGENT_VERSION}. Hay que actualizarlo a mano.`);
          } else {
            log(`Actualizacion disponible: v${up.version} (intento ${yaIntentado + 1} de ${MAX_INTENTOS_UPDATE})`);
            anotarIntentoUpdate(config, up.version);
            await selfUpdate(up.url, up.version, config, up.sha256);
          }
        }
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

      // Chequeo de backup a pedido
      if (res.data && res.data.check_backup) {
        log('Backup check solicitado');
        const bk = await getBackupStatus(true);
        if (bk) {
          await httpRequest(`${config.serverUrl}/api/heartbeat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ machine_key: config.machineKey, backup_status: bk })
          });
          log(`Backup check: ${bk.status} - ${bk.last_backup || bk.last_folder || 'sin datos'}`);
        }
      }

      // Ejecutar comandos remotos pendientes
      if (res.data && res.data.commands && res.data.commands.length > 0) {
        for (const cmd of res.data.commands) {
          const esperada = firmaEsperada(config.machineKey, 'cmd', String(cmd.id), cmd.command);
          if (!firmaValida(cmd.sig, esperada)) {
            log(`Comando #${cmd.id} IGNORADO: firma invalida`);
            continue;
          }
          log(`Comando remoto #${cmd.id}: ${cmd.command}`);
          try {
            const { exec } = require('child_process');
            const output = await new Promise((resolve) => {
              exec(cmd.command, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
                resolve((stdout || '') + (stderr ? '\n[STDERR] ' + stderr : '') + (err && err.killed ? '\n[TIMEOUT]' : ''));
              });
            });
            log(`Comando #${cmd.id} resultado: ${(output || '').substring(0, 100)}...`);
            await httpRequest(`${config.serverUrl}/api/command-result`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ machine_key: config.machineKey, command_id: cmd.id, output })
            });
          } catch (e) {
            log(`Comando #${cmd.id} error: ${e.message}`);
          }
        }
      }
    } else log(`Heartbeat ERROR: ${JSON.stringify(res.data)}`);
  } catch (err) { log(`Heartbeat FAILED: ${err.message}`); }
}

// Heartbeat loop
function startHeartbeatLoop(config) {
  log(`Agente iniciado - ${config.machineName}`);
  migrarUrlServidor(config);
  asegurarScripts();
  // Si quedo una bandera de un update anterior, sacarla: ya arrancamos.
  try { if (fs.existsSync(FLAG_UPDATE)) fs.unlinkSync(FLAG_UPDATE); } catch {}
  // Si arrancamos siendo la version que se venia intentando, el update salio
  // bien y el contador tiene que volver a cero.
  if (config.updateIntentos && config.updateIntentos[AGENT_VERSION]) {
    log(`Update a v${AGENT_VERSION} aplicado correctamente`);
    limpiarIntentosUpdate(config);
  }
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

function contenidoVbsSilencioso() {
  return `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run chr(34) & "${EXE_PATH.replace(/\\/g, '\\\\')}" & chr(34), 0, False\r\n`;
}

function contenidoVbsWatchdog() {
  const exeName = path.basename(EXE_PATH);
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    // Durante un update los archivos se estan renombrando. Si el watchdog
    // levanta el binario viejo en ese momento, el nuevo arranca, ve el lock de
    // la instancia vieja y se va en silencio: la maquina queda en la version
    // anterior y vuelve a pedir el update al minuto siguiente, para siempre.
    // Sin duplicar las barras: en VBS las cadenas son literales, no llevan
    // escape. Se embebe igual que la ruta del exe unas lineas mas abajo.
    `bandera = "${FLAG_UPDATE}"`,
    'If fso.FileExists(bandera) Then',
    // Con vencimiento: si un update queda colgado, la bandera no puede dejar el
    // watchdog apagado para siempre.
    '  If DateDiff("n", fso.GetFile(bandera).DateLastModified, Now) < 10 Then WScript.Quit',
    'End If',
    'tempFile = fso.GetSpecialFolder(2) & "\\se_check.tmp"',
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
}

// Las instalaciones que ya estan en la calle tienen el watchdog viejo, sin el
// chequeo de la bandera. Se reescribe al arrancar para que el arreglo llegue
// solo, sin reinstalar a mano en cada maquina.
function asegurarScripts() {
  for (const [ruta, contenido] of [[VBS_FILE, contenidoVbsSilencioso()], [WATCHDOG_FILE, contenidoVbsWatchdog()]]) {
    try {
      if (fs.existsSync(ruta) && fs.readFileSync(ruta, 'utf8') === contenido) continue;
      fs.writeFileSync(ruta, contenido);
      log(`Script de arranque actualizado: ${path.basename(ruta)}`);
    } catch (e) {
      log(`No se pudo actualizar ${path.basename(ruta)}: ${e.message}`);
    }
  }
}

// Instalar como tarea programada (corre sin ventana al iniciar Windows)
function install() {
  const exeName = path.basename(EXE_PATH);
  const watchdogVbs = WATCHDOG_FILE;
  fs.writeFileSync(VBS_FILE, contenidoVbsSilencioso());
  fs.writeFileSync(watchdogVbs, contenidoVbsWatchdog());

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

// Instalacion: copiar exe a carpeta elegida y relanzar desde ahi
async function installToFolder() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));
  const defaultDir = 'C:\\ServerEyes';

  console.log('\n========================================');
  console.log('   ServerEyes Agent - Instalacion');
  console.log('========================================\n');
  console.log('Este asistente instalara el agente en tu servidor.\n');

  const inputDir = await ask(`Carpeta de instalacion [${defaultDir}]: `);
  const installDir = inputDir.trim() || defaultDir;
  rl.close();

  // Crear carpeta si no existe
  if (!fs.existsSync(installDir)) {
    try {
      fs.mkdirSync(installDir, { recursive: true });
      console.log(`\nCarpeta creada: ${installDir}`);
    } catch (err) {
      console.log(`\nError al crear la carpeta: ${err.message}`);
      console.log('Ejecuta como Administrador si la carpeta requiere permisos elevados.');
      process.exit(1);
    }
  }

  const exeName = path.basename(EXE_PATH);
  const destExe = path.join(installDir, exeName);

  // Si ya estamos en la carpeta destino, no copiar
  if (path.resolve(EXE_DIR) === path.resolve(installDir)) {
    console.log(`\nEl agente ya esta en ${installDir}`);
    return true;
  }

  // Copiar exe a la carpeta destino
  try {
    fs.copyFileSync(EXE_PATH, destExe);
    console.log(`\nAgente copiado a: ${destExe}`);
  } catch (err) {
    console.log(`\nError al copiar: ${err.message}`);
    process.exit(1);
  }

  // Relanzar desde la nueva ubicacion con --setup
  console.log('Iniciando configuracion desde la nueva ubicacion...\n');
  const child = spawn(destExe, ['--setup'], { stdio: 'inherit', detached: false });
  child.on('close', (code) => process.exit(code || 0));
  return false;
}

// Setup interactivo
async function setup() {
  const config = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  console.log('\n=== ServerEyes Agent - Configuracion ===\n');
  console.log(`Ubicacion: ${EXE_DIR}`);
  console.log(`Config actual:`);
  console.log(`  Servidor: ${config.serverUrl || '(no configurado)'}`);
  console.log(`  Clave:    ${config.machineKey ? config.machineKey.slice(0, 8) + '...' : '(no configurado)'}`);
  console.log(`  Nombre:   ${config.machineName}\n`);

  const serverUrl = await ask(`URL del servidor [${config.serverUrl || 'https://servereyes.app'}]: `);
  if (serverUrl.trim()) config.serverUrl = serverUrl.trim().replace(/\/$/, '');
  else if (!config.serverUrl) config.serverUrl = 'https://servereyes.app';

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

// Single instance lock via lock file
const LOCK_FILE = path.join(EXE_DIR, 'servereyes.lock');

function isAlreadyRunning() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (isNaN(pid)) return false;
    // Check if process with that PID is still alive
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch { return false; }
}

function acquireLock() {
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
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

  if (isAlreadyRunning()) {
    console.log('ServerEyes Agent ya esta corriendo. Saliendo.');
    process.exit(0);
  }

  const config = loadConfig();

  if (!config.serverUrl || !config.machineKey) {
    // Primera ejecucion: preguntar donde instalar y luego configurar
    const continueHere = await installToFolder();
    if (!continueHere) return;
    await setup();
    return;
  }

  acquireLock();

  startHeartbeatLoop(config);
}

main().catch(console.error);
