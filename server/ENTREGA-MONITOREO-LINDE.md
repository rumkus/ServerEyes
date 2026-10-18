# Entrega — Monitoreo de Linde/staging en ServerEyes

Rama `codex/monitoreo-http-health` (base `main`). Documento de diseño/operación:
`server/MONITOREO-HTTP.md`. Esta entrega separa **implementado**, **probado en
local** y **verificado en la instancia real** (ver §7 y §10).

---

## 1. Resumen de lo implementado y archivos modificados

Se **extendió** el monitor de URLs existente (no se creó un sistema paralelo). Se
agregó política estricta de salud, incidentes para URL (reutilizando `incidents`),
TLS real, control de concurrencia y evidencia.

Archivos:
- `server/lib/url-guard.js` *(mod)* — `followRedirects` captura cuerpo acotado + URL
  final + resultado TLS; `opts.rejectUnauthorized` (TLS real) y `maxRedirects=0` (no
  seguir redirección, devolver 3xx marcado). Sin cambios para los callers previos.
- `server/lib/health-check.js` *(nuevo)* — `evaluarSalud`/`clasificarError`: status
  exacto, JSON por propiedad, redirección=caída, TLS, cuerpo grande, categorías de error.
- `server/lib/url-incidents.js` *(nuevo)* — incidente idempotente (un solo abierto por
  caída), resolución con duración, transición de estado, y entrega de avisos con
  reclamo atómico + reintento sin duplicar (mismo patrón que `lib/offline.js`).
- `server/server.js` *(mod)* — columnas (`expected_json`, `health_mode`, `enforce_tls`,
  `last_error_kind`, `alert_pendiente`, `incidents.url_id`, `url_check_history.error_kind`);
  `probeUrl`/`checkUrlMonitor` con la política estricta + incidentes; **reclamo atómico**
  de vencidos (multi-worker); entrega de avisos por ciclo; `GET` con `estado`,
  `outage_seconds`, `proxima_check`, `scheduler_pausado`; `POST/PUT` aceptan los campos
  health; endpoint `GET /api/url-monitors/:id/incidents`; latido del scheduler;
  siembra idempotente de los 3 controles.
- `server/public/index.html` *(mod)* — estado `Desactualizado`, "caído hace Xm",
  categoría de error, aviso de verificador pausado.
- `server/MONITOREO-HTTP.md` *(mod)* y este documento.
- Tests *(nuevos/mod)*: `health-check.test.js`, `url-monitor.test.js`,
  `url-monitor-api.test.js`, `url-incidents.test.js`.

**Bug corregido durante la verificación:** las `ALTER TABLE` de `url_check_history`
(`error_kind`) e `incidents` (`url_id`) estaban **antes** de los `CREATE TABLE`
correspondientes → en una base nueva fallaban en silencio y las columnas no se creaban
(el historial de errores y los incidentes de URL no persistían). Se movieron las ALTER
después de cada CREATE. Verificado en una base **nueva** (un solo `initDB`): ambas
columnas quedan creadas.

## 2. Contrato real del API y defaults efectivos

Confirmado leyendo el código (no inventado).

**`POST /api/url-monitors`** (y `PUT /api/url-monitors/:id`) — `Authorization: Bearer <TOKEN>`:

| Campo | Default | Notas |
|---|---|---|
| `url` | — (requerido) | validado anti-SSRF (`urlGuard.validarDestino`) |
| `name` | = `url` | |
| `method` | `GET` | |
| `expected_status` | `200` | status exacto exigido en health_mode |
| `timeout_ms` | `10000` | cubre también la lectura del cuerpo |
| `interval_seconds` | `300` | |
| `health_mode` | `false` | activa política estricta |
| `expected_json` | `null` | objeto `{clave: valor}`; array → 400 |
| `enforce_tls` | `false` | exige HTTPS + valida cert/hostname/vigencia |
| `notify_emails` | `[]` | destinatarios extra (opt-in) |
| `notify_down` | `true` | (columna; avisa caída/recuperación) |

Rutas reales: `GET /api/url-monitors` (lista + estado computado), `POST`, `PUT /:id`,
`DELETE /:id`, `GET /:id/history`, `GET /:id/incidents`. Todas con `authenticateToken`
y alcance por dueño (o técnico con la URL compartida).

## 3. Los tres curl finales (tokens como placeholder)

```bash
TOKEN=<TOKEN>; BASE=https://<servereyes-real>

curl -X POST "$BASE/api/url-monitors" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://web-staging-6538.up.railway.app/health/ready","name":"Linde/staging Web","health_mode":true,"enforce_tls":true,"expected_json":{"status":"ok","service":"web"}}'

curl -X POST "$BASE/api/url-monitors" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://admin-staging-33d1.up.railway.app/health/ready","name":"Linde/staging Administrador","health_mode":true,"enforce_tls":true,"expected_json":{"status":"ok","service":"admin"}}'

curl -X POST "$BASE/api/url-monitors" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://api-staging-46412.up.railway.app/health/ready","name":"Linde/staging API","health_mode":true,"enforce_tls":true,"expected_json":{"status":"ok","service":"api"}}'
```

## 4. Request/response reales de creación (instancia local de verificación)

`POST /api/url-monitors` (Web) → **200**, response:

```json
{ "id": 1, "url": "https://web-staging-6538.up.railway.app/health/ready",
  "name": "Linde/staging Web", "method": "GET", "expected_status": 200,
  "timeout_ms": 10000, "interval_seconds": 300, "health_mode": true,
  "enforce_tls": true, "expected_json": {"status":"ok","service":"web"},
  "is_active": true, "is_up": true, "last_check": null }
```

`PUT /api/url-monitors/:id` con `{"expected_json":{"status":"ok","service":"api"}}` →
**200**, devuelve el monitor con `expected_json` actualizado (se usó en la demo de
recuperación: al corregir la aserción, el siguiente chequeo lo marcó sano).

## 5. Consultas de estado / mediciones / incidentes (endpoints reales)

- **Estado/config**: `GET /api/url-monitors` → cada monitor con `estado`
  (`sin_comprobar|saludable|caido|desactualizado`), `last_check`, `proxima_check`,
  `last_status`, `last_response_ms`, `last_error`, `last_error_kind`, `outage_seconds`,
  `scheduler_pausado`, `scheduler_ultimo_tick`, y la config efectiva.
- **Mediciones**: `GET /api/url-monitors/:id/history?limit=N&only_failures=true` →
  `checked_at, is_up, status, response_ms, error, error_kind, attempts, notified`.
- **Incidentes**: `GET /api/url-monitors/:id/incidents` → `id, status, started_at,
  ended_at, duration_minutes, title, event_count`.

## 6. Tabla de los tres monitores (medición real del scheduler, instancia local)

| ID | Nombre | URL | Frecuencia | Timeout | Activo | Última ejec. scheduler | Resultado |
|----|--------|-----|-----------|---------|--------|------------------------|-----------|
| 1 | Linde/staging Web | web-staging-6538…/health/ready | 300s | 10000ms | sí | 21:43:23 → próx 21:48:23 | **200, is_up, 339ms** |
| 2 | Linde/staging Administrador | admin-staging-33d1…/health/ready | 300s | 10000ms | sí | 21:43:23 → próx 21:48:23 | **200, is_up, 341ms** |
| 3 | Linde/staging API | api-staging-46412…/health/ready | 300s | 10000ms | sí | 21:43:23 → próx 21:48:23 | **200, is_up, 338ms** |

Medición ejecutada por el **scheduler** (no manual): filas en `url_check_history`
(`attempts=1`, `error_kind=null`).

## 7. Pruebas: comandos, cantidades, resultados y limitaciones

Comando: `TEST_DATABASE_URL=postgres://… JWT_SECRET=… npm test`
(= `node --test --test-concurrency=1 "test/*.test.js"`; Postgres de prueba vía Docker).

- **148 pruebas, 148 OK, 0 fallos.** Cubre: 200+JSON correcto; 503; 200 con HTML/JSON
  inválido/servicio incorrecto; redirección (seguida y **no seguida**); timeout y
  respuesta sin terminar; DNS; TLS no confiable; **cuerpo grande**; caída confirmada +
  **incidente único** + recuperación; **deduplicación** y **reintento de entrega**;
  scheduler (tick/pausa) y **concurrencia** (claim atómico); **autorización/aislamiento**
  y **SSRF** (el bypass del validador es sólo de test, nunca en prod).
- **Chequeo real read-only** de los 3 endpoints vivos con TLS estricto: 200 + cert
  válido + JSON exacto (~230-340ms). Sin detener ni modificar Linde/staging.
- **Evidencia del scheduler** (ver §6) + demo en vivo caída→incidente→recuperación.
- **Limitación**: los casos destructivos (TLS inválido real, DNS roto) se cubren con
  fixtures/mock y por clasificación; no se degradó ningún servicio real para probarlos.

## 8. Alertas realmente recibidas — PENDIENTE (separado de lo automatizado)

La lógica de aviso (caída/recuperación), la **deduplicación** y el **reintento de
entrega** están implementados y probados. **La recepción real de una alerta NO está
verificada**: requiere (a) un destinatario de prueba autorizado cargado por el opt-in,
y (b) SMTP/push configurado en el entorno. Procedimiento listo para ejecutarse: monitor
temporal con aserción incorrecta → caída confirmada → aviso; corregir → recuperación →
aviso; registrar qué se recibió. **No se declara verificado hasta recibirlo.**

## 9. Scheduler y PC del administrador apagada

- Scheduler = `setInterval` en el **backend de ServerEyes (Railway)**; `start = node
  server.js`. Re-arma solo al iniciar; los vencidos se recalculan por `last_check`.
- **Con la PC del admin apagada, los controles siguen activos** (corren en el backend,
  no en ninguna PC). Única dependencia: que el servicio de Railway esté levantado.
- **Independencia de fallas**: Linde/staging (`*.up.railway.app`) y ServerEyes están
  **ambos en Railway** → comparten proveedor; una caída de Railway afecta a los dos y
  ServerEyes no podría avisar. Vigilancia externa (worker + antigüedad de backups) =
  **etapa posterior**, aún sin cobertura.

## 10. Commit y estado de despliegue

- Rama `codex/monitoreo-http-health` (base `main`). Commit de esta entrega: ver
  `git log` de la rama (se indica en el mensaje de entrega).
- **NO desplegado** y **NO configurado en la instancia real** todavía. Para activarlo:
  merge a `main` + push (Railway auto-deploy); los 3 controles se siembran solos al
  iniciar (bajo el primer admin) salvo `SEED_STAGING_CONTROLS=0`, o se crean con los
  curl de §3. **Falta (datos a proveer):** OK de despliegue, destinatario de prueba, y
  confirmar SMTP en el entorno.
