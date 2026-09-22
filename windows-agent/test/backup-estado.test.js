// Clasificacion del estado de backup: evidencia vs. ausencia confirmada vs.
// fallo de consulta/permisos (estado desconocido). Puro, sin Windows.
const { test } = require('node:test');
const assert = require('node:assert');
const { clasificarBackup } = require('../backup-estado');

test('clasificarBackup', async (t) => {
  await t.test('ambas consultas OK sin evidencia -> "No se encontro evidencia" (no "no configurado")', () => {
    // wevtutil exit 0 vacio; dir falla porque la carpeta no existe (no es permiso)
    const r = clasificarBackup(
      { err: '', out: '' },
      { err: 'El nombre de archivo, el nombre de directorio o la sintaxis de la etiqueta del volumen no son correctos.', out: '' }
    );
    assert.strictEqual(r.status, 'not_configured');
    assert.strictEqual(r.status_text, 'No se encontro evidencia de Windows Backup');
  });

  await t.test('dir con acceso denegado -> estado desconocido', () => {
    const r = clasificarBackup({ err: '', out: '' }, { err: 'Acceso denegado.', out: '' });
    assert.strictEqual(r.status, 'unknown');
    assert.match(r.status_text, /no se pudo/i);
  });

  await t.test('wevtutil con acceso denegado (ingles) -> estado desconocido', () => {
    const r = clasificarBackup({ err: 'Access is denied', out: '' }, { err: 'File Not Found', out: '' });
    assert.strictEqual(r.status, 'unknown');
  });

  await t.test('ambas fallan por permisos -> desconocido', () => {
    const r = clasificarBackup({ err: 'Acceso denegado', out: '' }, { err: 'Access is denied', out: '' });
    assert.strictEqual(r.status, 'unknown');
  });

  await t.test('evidencia por eventos (Information) -> ok', () => {
    const r = clasificarBackup(
      { err: '', out: 'Event[0]:\n  Date: 2026-09-20T02:00:00\n  Level: Information\n  Message: Backup completado' },
      { err: '', out: '' }
    );
    assert.strictEqual(r.status, 'ok');
    assert.ok(r.last_backup);
  });

  await t.test('evidencia por eventos (Error) -> error', () => {
    const r = clasificarBackup(
      { err: '', out: 'Event[0]:\n  Level: Error\n  Message: El backup fallo' },
      { err: '', out: '' }
    );
    assert.strictEqual(r.status, 'error');
  });

  await t.test('evidencia por eventos (Warning) -> warning', () => {
    const r = clasificarBackup(
      { err: '', out: 'Event[0]:\n  Level: Warning\n  Message: algo' },
      { err: '', out: '' }
    );
    assert.strictEqual(r.status, 'warning');
  });

  await t.test('evidencia por imagen en WindowsImageBackup -> ok', () => {
    const r = clasificarBackup({ err: '', out: '' }, { err: '', out: '2026-09-19\n2026-09-20' });
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.last_backup, '2026-09-20');
  });

  await t.test('eventos ilegibles por permisos pero imagen presente -> ok (gana la evidencia)', () => {
    const r = clasificarBackup({ err: 'Acceso denegado', out: '' }, { err: '', out: 'copia1' });
    assert.strictEqual(r.status, 'ok');
  });
});
