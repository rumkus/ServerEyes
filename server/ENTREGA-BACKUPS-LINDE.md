# Entrega — Alertas de backups de Linde en ServerEyes

Separado en **implementado / probado local / verificado en la instancia real**.
Diseño y contrato: `server/MONITOREO-BACKUPS.md`.

## 1. Qué se implementó (ServerEyes) + despliegue

- `server/lib/backup-monitor.js` (nuevo): validación, frescura 26h (UTC/TIMESTAMPTZ),
  dedup/orden/concurrencia, incidentes, recuperación, scheduler, entrega con reintento.
- `server/server.js`: tablas `backup_monitors`, `backup_events`,
  `incidents.backup_monitor_id`; endpoints (ingesta/consulta/rotate); scheduler 5 min;
  siembra idempotente del monitor.
- Migraciones: sólo `CREATE TABLE IF NOT EXISTS` + `ALTER … ADD COLUMN IF NOT EXISTS`
  (compatibles; la DB de prod ya existente sólo suma columnas/tablas).
- **URL real:** `https://servereyes.app` (Railway, proyecto `fabulous-wisdom`, servicio
  `ServerEyes`, env `production`).
- **Commit desplegado:** `ffafeed` → deploy `58893767-9920-411c-ae1e-d753be80eff0`
  **SUCCESS**. Log: `[SEED] monitor de backups Linde/staging asegurado; nuevo=1`.
  Endpoint verificado en prod: `POST /api/backup-monitors/1/events` sin token → **401**.
- **Scheduler fuera de la PC:** corre en el backend de Railway (`setInterval`), no en
  ninguna PC. **Brecha informada:** ServerEyes está en Railway igual que Linde (distinto
  proyecto, mismo proveedor) → NO es independiente de una caída de Railway. Vigilancia
  externa = etapa posterior. **No se declara monitoreo independiente.**

## 2. Monitor real

| Campo | Valor |
|---|---|
| ID | `1` |
| Nombre | `Linde/staging backups Google Drive` |
| Ambiente | `staging` |
| Estado | `pendiente` (sin copia válida; nunca saludable por defecto) |
| Umbral (frescura) | `93600s` (26h) |
| Frecuencia de evaluación | cada 5 min (scheduler) |
| Canal | push (FCM, configurado en prod) + email (destinatarios opt-in, sin personales) |
| Última captura válida | — (aún no recibió recibos reales) |
| Token | sin generar (lo obtiene el admin con rotate-token) |

Diferenciación: **configurado** (sembrado, endpoint vivo) · **integración** (exportador
→ ServerEyes) **pendiente** · **validación efectiva** con recibo real **pendiente**.

## 3. Contrato API final (rutas REALES, verificadas)

Base: `https://servereyes.app`

**Ingesta** `POST /api/backup-monitors/:id/events` · `Authorization: Bearer <MONITOR_TOKEN>`
- Éxito: `{"event":"offsite_backup_verified","backupId":"<uuid>","capturedAt":"<ISO UTC>","id":"<Drive fileId>","bytes":<int>,"sha256":"<64hex>","downloadVerified":true,"verifiedAt":"<ISO UTC>"}`
- Fallo (contrato nuevo): `{"event":"offsite_backup_failed","runId":"<id>","backupId":"<opc>","reason":"<saneada>","failedAt":"<ISO UTC>"}`
- Respuestas: `200 {ok,resultado}` (`aplicado|duplicado|viejo|superado`) · `400 {error,motivo}`
  · `401` · `409` (conflicto: mismo backupId con sha/bytes distintos) · `500`.
- Idempotencia: dedup por `backupId` (éxito) / `runId` (fallo); sólo una captura con
  `capturedAt` mayor reemplaza; `capturedAt` futuro rechazado (tolerancia 5 min).
- Ejemplos reales obtenidos (ensayo, instancia local):
  - `POST verified` → `200 {"ok":true,"resultado":"aplicado","estado":"saludable"}`
  - `POST verified` (repetido) → `200 {"ok":true,"resultado":"duplicado"}`
  - `POST verified` (mismo backupId, sha distinto) → `409`
  - `POST verified` (bytes 0) → `400 {"error":"evento invalido","motivo":"bytes debe ser positivo"}`
  - `POST failed` → `200 {"ok":true,"resultado":"aplicado"}`
  - sin token → `401 {"error":"no autorizado"}`

**Consulta** (JWT de usuario, por dueño):
- `GET /api/backup-monitors` → estado, `estado_frescura`, `segundos_desde_captura`,
  `last_success_*`, `last_failure_*`, `incidentes_abiertos`, `tiene_token` (nunca el hash).
- `GET /api/backup-monitors/:id/incidents` · `GET /api/backup-monitors/:id/events`.

**Credencial** (admin): `POST /api/backup-monitors/:id/rotate-token` → `{id,name,environment,token}`
(token en claro una vez; sólo se guarda el hash sha256). Es un contrato NUEVO.

## 4. Variables en Railway (servicio `backup` de Linde) + cambio del exportador

Cargar como **secretos** (nunca en Git/chat/logs):
- `SERVEREYES_BACKUP_URL` = `https://servereyes.app/api/backup-monitors/1/events`
- `SERVEREYES_BACKUP_TOKEN` = token de `rotate-token` (lo genera el admin de ServerEyes)
- `SERVEREYES_BACKUP_ENV` = `staging` (opcional)

Cambio del exportador (Linde, rama local `codex/servereyes-backup-receipt` commit `8525566`,
**no pusheada** para no tocar su trabajo en curso ni su runner):
- `packages/offsite/src/notify.mjs` (nuevo): `sendServerEyesEvent` (fetch/sleep inyectables;
  2xx=aceptado, 4xx=rechazo definitivo sin reintento, 5xx/red/timeout=reintento acotado)
  + `sanitizeCause`. **Sin secretos en logs.**
- `packages/offsite/src/cli.mjs`: tras `store.upload` arma el evento, lo loguea (sin cambios)
  y lo **envía a ServerEyes**; el `catch (err)` emite `offsite_backup_failed` saneado.
  El aviso es **independiente** de la copia; su fallo no reclasifica la copia ni re-captura.
- `packages/offsite/src/notify.test.mjs` (nuevo): 8 pruebas. Sin cambios de CI/runner/shell.

Procedimiento: (a) admin de ServerEyes corre `rotate-token` y guarda el token;
(b) cargar las 3 variables en el servicio `backup`; (c) pushear/mergear la rama de Linde y
desplegar; (d) ejecutar un ciclo real y verificar el recibo; (e) observar la primera ventana
nocturna. **Mantener el cron `0 6 * * *` UTC y 26h en el monitor real.**

## 5. Pruebas (comando / esperado / observado / resultado)

ServerEyes — `TEST_DATABASE_URL=… JWT_SECRET=… node --test "test/*.test.js"` → **169/169**.
Linde — `node --test src/notify.test.mjs` (packages/offsite) → **8/8**.

| Caso | Esperado | Observado | Resultado |
|---|---|---|---|
| verified real → saludable | estado saludable, campos correlacionados | `aplicado`, saludable, backupId/bytes guardados | OK (ensayo) |
| falta de evento (umbral corto) | scheduler abre incidente de vencido | incidente "Backup vencido" abierto por el warm-up | OK (ensayo en vivo) |
| ejecución fallida | sin éxito; incidente | `failed`→incidente único, estado `fallo` | OK |
| recuperación | cierra incidente + aviso | verified reciente → incidente `resolved` | OK |
| frontera 26h (reloj inyectado) | 26h no vence; +1s sí; vieja no recupera | exacto=saludable, +1s=vencido | OK (simulado) |
| duplicados/concurrencia/desorden | una transición; copia nueva preservada; fallo viejo no reabre | duplicado/conflicto/viejo/superado + 1 aviso concurrente | OK |
| token malo / otro ambiente / payload inválido o futuro | rechazo sin tocar salud/incidentes | 401 / 400 / rechazo | OK |
| caída/timeout del envío (lado Linde) | copia conservada; reintento acotado; fallo visible | retry 5xx/timeout, 4xx sin retry, no re-captura | OK |
| reinicio de ServerEyes | estado/incidentes conservados; frescura sigue | tablas persistentes; scheduler se re-arma | OK (persistencia en DB) |

## 6. Evidencia de caída/recuperación recibidas

- **Detección** (caída por fallo y por vencimiento) y **recuperación**: verificadas en el
  ensayo en vivo (incidentes abiertos/resueltos en la base). **Sintético/cloud:** el ensayo
  corrió en instancia local + Postgres; la lógica es idéntica a prod.
- **Recepción del aviso por un canal autorizado: PENDIENTE.** Se validó envío + dedup +
  reintento, pero **no** la recepción real (push/email) por el titular. Requiere destinatario
  de prueba y SMTP del entorno (FCM ya configurado en prod). Los avisos del ensayo se marcan
  **PRUEBA** y no se cambió el destino a terceros.

## 7. Pendientes concretos y próximo paso

1. **Token + variables Railway** (titular/admin): `rotate-token` → cargar las 3 variables en
   el servicio `backup`. (dato a proveer de forma segura: el token; nunca por chat.)
2. **Integración real Linde PENDIENTE** (Codex): pushear/mergear `codex/servereyes-backup-receipt`
   y desplegar el exportador; un POST sintético NO acredita la conexión del cron.
3. **Validación con recibo real:** ejecutar un ciclo real del exportador → verificar `aplicado`
   + estado saludable con `backupId/capturedAt/sha` correlacionados.
4. **Primera ventana nocturna** (03:00 Argentina): requiere evidencia posterior; aún sin observar.
5. **Recepción real del aviso** por el canal autorizado (destinatario de prueba + SMTP).
6. **Docs de Linde** (`docs/15-estado.md`, `docs/37-backups-durables.md`,
   `infra/monitoring/README.md`): actualizarlas al mergear la rama (hoy tienen cambios del
   titular sin commitear; no se tocaron para conservarlos).

No se declara cobertura del worker ni restauraciones automáticas por conectar estas alertas.
