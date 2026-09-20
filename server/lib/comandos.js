// Comandos remotos: entrega y resultado.
//
// Estados de un comando:
//   pending       encolado por el usuario, todavia no lo retiro ningun latido
//   delivered     un latido lo reservo y se lo llevo al agente
//   completed     el agente lo ejecuto y mando la salida
//   failed        el agente no pudo ejecutarlo (error al lanzar el proceso)
//   indeterminate el agente se reinicio mientras corria: no se sabe que paso,
//                 y NO se vuelve a ejecutar solo
//
// La reserva es atomica: dos latidos solapados de la misma maquina no se
// llevan el mismo comando (FOR UPDATE SKIP LOCKED). Una vez entregado, el
// servidor no lo vuelve a ofrecer: si el agente lo perdio (se cayo la red
// justo despues de reservar), queda en "delivered" sin resultado y el usuario
// decide si lo manda de nuevo. Preferimos eso a repetir por las nuestras un
// comando que quizas ya corrio.
//
// Lo que esto NO garantiza es "exactamente una vez": el agente puede ejecutar
// y morir antes de persistir su registro. Ahi el comando queda "delivered" y
// en el agente no hay rastro; se lo trata como perdido, no se reintenta.

const ESTADOS_RESULTADO = new Set(['completed', 'failed', 'indeterminate']);
const MAX_OUTPUT = 10000;

async function reservarComandos(pool, machineId, limite = 5) {
  const r = await pool.query(
    `UPDATE remote_commands SET status = 'delivered', delivered_at = NOW(), delivery_count = COALESCE(delivery_count, 0) + 1
     WHERE id IN (
       SELECT id FROM remote_commands
       WHERE machine_id = $1 AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, command`,
    [machineId, limite]
  );
  return r.rows;
}

// Registra el resultado que manda el agente. Idempotente: si el mismo
// resultado llega dos veces (el agente reenvia porque no vio la respuesta),
// la segunda no pisa nada y responde ok igual. Solo se acepta para comandos
// de esa maquina que esten entregados (o pendientes, por si un agente viejo
// responde a un comando que retiro antes de esta version).
async function registrarResultado(pool, machineId, commandId, { status, output }) {
  const estado = ESTADOS_RESULTADO.has(status) ? status : 'completed';
  const salida = String(output || '').slice(0, MAX_OUTPUT);
  const r = await pool.query(
    `UPDATE remote_commands SET status = $1, output = $2, executed_at = NOW()
     WHERE id = $3 AND machine_id = $4 AND status IN ('pending', 'delivered')
     RETURNING id`,
    [estado, salida, commandId, machineId]
  );
  if (r.rows.length > 0) return { aplicado: true };
  const existe = await pool.query('SELECT status FROM remote_commands WHERE id = $1 AND machine_id = $2', [commandId, machineId]);
  if (existe.rows.length === 0) return { aplicado: false, motivo: 'no_existe' };
  return { aplicado: false, motivo: 'ya_resuelto', status: existe.rows[0].status };
}

module.exports = { reservarComandos, registrarResultado, ESTADOS_RESULTADO };
