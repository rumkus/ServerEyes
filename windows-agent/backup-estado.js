// Clasificacion del estado de Windows Backup a partir de la salida de dos
// consultas: eventos (wevtutil) e imagen en C:\WindowsImageBackup (dir).
// Se separa en un modulo puro para poder testearlo sin Windows ni exec.
//
// Reglas:
//   - Hay evidencia (eventos o imagen) -> ok / error / warning.
//   - Ambas consultas se pudieron hacer y no hay evidencia -> NO se encontro
//     evidencia (no afirmamos "no configurado": puede estar configurado y no
//     haber corrido, o correr con otra herramienta).
//   - Alguna consulta fallo por permisos / servicio -> estado DESCONOCIDO.

function formatBackupDate(raw) {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  } catch { return raw; }
}

// Un error de PERMISOS deja el chequeo "sin confirmar" (desconocido). Un error
// de "no existe" (canal/carpeta ausente) SI confirma que no hay backup por ese
// lado. Se reconoce por el texto, en espanol e ingles.
function esPermiso(t) { return /denegad|denied|permission|no autoriz|acceso/i.test(t || ''); }

// ev = { err, out } de wevtutil; img = { err, out } de dir. err = mensaje (o '').
function clasificarBackup(ev, img) {
  const evErr = (ev && ev.err) || '';
  const evOut = ((ev && ev.out) || '').trim();
  const imgErr = (img && img.err) || '';
  const imgOut = ((img && img.out) || '').trim();

  // 1) Evidencia por eventos de Windows Backup (ejecucion real: ok/error/warning).
  if (!evErr && evOut) {
    const dateMatch = evOut.match(/Date:\s*(.+)/i) || evOut.match(/Fecha:\s*(.+)/i);
    const levelMatch = evOut.match(/Level:\s*(.+)/i) || evOut.match(/Nivel:\s*(.+)/i);
    const msgMatch = evOut.match(/Message:\s*([\s\S]*?)(?:\n\n|\nEvent|\n$)/i) || evOut.match(/Mensaje:\s*([\s\S]*?)(?:\n\n|\nEvento|\n$)/i);
    const level = levelMatch ? levelMatch[1].trim().toLowerCase() : '';
    const message = msgMatch ? msgMatch[1].trim().substring(0, 300) : '';
    let status = 'ok', status_text = 'Backup realizado con exito';
    if (level.includes('error') || level.includes('critical') || level.includes('critico')) { status = 'error'; status_text = 'El backup fallo'; }
    else if (level.includes('warning') || level.includes('advertencia')) { status = 'warning'; status_text = 'Backup con advertencias'; }
    return { status, status_text, last_backup: dateMatch ? formatBackupDate(dateMatch[1].trim()) : null, message: message || null };
  }

  // 2) Evidencia por imagen en C:\WindowsImageBackup.
  if (!imgErr && imgOut) {
    const ultima = imgOut.split('\n').pop();
    return { status: 'ok', status_text: 'Backup realizado con exito', last_backup: ultima ? ultima.trim() : null };
  }

  // 3) Sin evidencia: distinguir ausencia confirmada de fallo de consulta.
  const eventosConfirmado = !evErr || !esPermiso(evErr);
  const imagenConfirmado = !imgErr || !esPermiso(imgErr);
  if (eventosConfirmado && imagenConfirmado) {
    return { status: 'not_configured', status_text: 'No se encontro evidencia de Windows Backup' };
  }
  return {
    status: 'unknown',
    status_text: 'No se pudo verificar el backup',
    message: 'No se pudo leer el estado del backup (permisos o servicio no disponible). Ejecutar el agente con privilegios para confirmarlo.'
  };
}

module.exports = { clasificarBackup, formatBackupDate, esPermiso };
