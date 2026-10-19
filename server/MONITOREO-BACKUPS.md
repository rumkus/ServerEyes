# Monitor de backups (recibos del exportador offsite de Linde)

ServerEyes vigila que la copia offsite de Linde/staging (Google Drive, cifrada con
age, cron `0 6 * * *` UTC = 03:00 Argentina) sea **reciente y verificada**. No
sondea Drive ni recibe secretos: **recibe** un recibo HTTPS autenticado que el
exportador emite **después** de descargar y comparar SHA-256.

No es un monitor HTTP (`url_monitors`). Reutiliza la tabla `incidents`
(`incidents.backup_monitor_id`), el scheduler (`setInterval`) y los avisos
(`sendPush`/`avisarAExtras`) con el patrón de reintento de entrega de
`lib/url-incidents`/`lib/offline`. Lógica en `server/lib/backup-monitor.js`.

## Contrato del API

### Ingesta (la usa el exportador)
`POST /api/backup-monitors/:id/events`
`Authorization: Bearer <TOKEN_DEL_MONITOR>`  (token EXCLUSIVO del monitor, no el JWT
de usuario ni una credencial global). `Content-Type: application/json`.

**Evento de éxito** (lo emite el exportador tras `downloadVerified:true`):
```json
{ "event": "offsite_backup_verified", "backupId": "<uuid>", "capturedAt": "<ISO UTC>",
  "id": "<Drive fileId>", "bytes": 818056, "sha256": "<64 hex>",
  "downloadVerified": true, "verifiedAt": "<ISO UTC>" }
```
`id` (id privado del archivo en Drive) se normaliza a `fileId` (también se acepta `fileId`).
Opcional `environment` (si viene, debe coincidir con el del monitor).

**Evento de fallo** (contrato NUEVO definido por ServerEyes):
```json
{ "event": "offsite_backup_failed", "runId": "<id ejecución>", "backupId": "<opcional>",
  "reason": "<causa saneada, sin secretos>", "failedAt": "<ISO UTC>" }
```

**Respuestas:** `200 {ok:true, resultado}` con `resultado`:
`aplicado` (nueva captura/fallo aplicado) · `duplicado` (mismo backupId/run ya recibido,
no renueva frescura ni reavisa) · `viejo` (captura más vieja que la última, no reemplaza)
· `superado` (fallo anterior a un éxito posterior, no abre incidente).
`400 {error,motivo}` validación · `401` token inválido/monitor inactivo · `409` conflicto
(mismo `backupId` con `sha256`/`bytes` distintos) · `500` interno.

**Validaciones:** `event` correcto, `downloadVerified===true`, `bytes>0`, `sha256`
64-hex, `capturedAt` válido y **no futuro** (tolerancia 5 min), ambiente y autorización.
Dedup por `backupId` (éxito) o `runId` (fallo). Orden/concurrencia: sólo una captura
con `capturedAt` **mayor** reemplaza la última (atómico). Causa de fallo saneada
(una línea, ≤300 chars).

### Consulta (JWT de usuario, alcance por dueño)
- `GET /api/backup-monitors` → estado, frescura, `last_success_*` (backupId, capturedAt,
  bytes, sha256, fileId, verifiedAt, received_at), `last_attempt/failure_*`,
  `estado_frescura`, `segundos_desde_captura`, `incidentes_abiertos`. **Nunca** expone el hash del token.
- `GET /api/backup-monitors/:id/incidents` → incidentes (abierto/resuelto, duración).
- `GET /api/backup-monitors/:id/events` → historial de eventos (sin secretos).

### Credencial (admin)
- `POST /api/backup-monitors/:id/rotate-token` (JWT admin) → devuelve el **token en claro
  UNA vez** (no se guarda ni se loguea; sólo su hash sha256). El admin lo carga en la
  variable del exportador. Rota/invalida el anterior.

## Estados e incidentes

- **pendiente** (inicial): sin copia válida. **Nunca saludable por defecto.** No dispara
  la alerta de 26h (no hay `capturedAt` que medir).
- **saludable**: última captura verificada dentro de la frescura (≤26h).
- **vencido**: `> freshness_seconds` (26h = 93600s) desde `capturedAt` de la última copia
  verificada. Lo detecta el scheduler (≤5 min) y abre incidente.
- **fallo**: evento de ejecución fallida sin éxito posterior → incidente inmediato (sin
  esperar 26h).
- **Un solo incidente abierto por causa**; la recuperación lo resuelve (con duración) y
  conserva la historia. **Recuperación sólo** con un éxito posterior verificado y captura
  **reciente** (un 200, un evento atrasado o una captura vieja no recuperan).
- Avisos (caída/recuperación) con deduplicación y **reintento de entrega** (reclamo
  atómico; si la entrega falla se revierte y reintenta sin duplicar). Pausar/editar no
  cuenta como recuperación.

Cálculos en **UTC** (`TIMESTAMPTZ`); mostrar en Argentina (UTC−3).

## Configuración del exportador (lado Linde)

Variables (por gestor/secreto, nunca en Git/chat/logs):
- `SERVEREYES_BACKUP_URL` = `https://<servereyes-real>/api/backup-monitors/<id>/events`
- `SERVEREYES_BACKUP_TOKEN` = token de `rotate-token` (credencial exclusiva del monitor).

El exportador envía el recibo **después** de `store.upload` con `downloadVerified:true`,
y un evento de fallo saneado en el `catch`. El resultado del aviso es **independiente**
del resultado de la copia: si ServerEyes falla, se conserva el éxito de la copia y se
registra el fallo de transporte; se reintenta sólo el aviso (timeout/backoff acotados),
sin re-capturar/re-subir. La ausencia de aviso la sigue detectando el control de 26h.

## Independencia de fallas (brecha informada)

ServerEyes corre en **Railway**, igual que Linde (proyectos distintos, mismo proveedor).
Su scheduler/estado/notificaciones **dependen de Railway**: una caída de Railway afectaría
a ambos y ServerEyes no podría avisar. Para vigilancia realmente independiente (detectar
una caída de Railway con la PC apagada) hace falta un verificador externo adicional
(etapa posterior). **No se declara monitoreo independiente.**

## Pruebas (automatizadas)

`node --test` (Postgres de prueba vía Docker): **169/169**. Del monitor de backups:
validación (futuro/sha/bytes/downloadVerified/ambiente), frontera **26h** (exacto no vence,
+1s sí), **dedup/duplicado/conflicto**, **orden** (captura vieja no reemplaza), captura
vieja recibida ahora (no renueva salud), **fallo→incidente único**, **superado** (fallo
viejo no reabre), **recuperación**, **frescura/scheduler** (abre vencido, idempotente),
**entrega con reintento** y **concurrencia** (un solo aviso), auth por token (401),
aislamiento (404), rotate (admin), códigos 200/400/409.

Ensayo en vivo (instancia local + Postgres): seed→rotate→verificado(saludable)→
fallo(incidente)→recuperación(resuelto)→vencimiento por el scheduler. **Pendiente**: la
recepción real del aviso por un canal autorizado (push/email) — requiere destinatario de
prueba y SMTP del entorno (FCM ya configurado en prod).
