# Monitoreo HTTP/HTTPS de apps y APIs (health-checks)

Extiende el monitor de URLs ya existente (`url_monitors` + verificador cada 60s +
historial + SSRF-guard + notificaciones) con una **política estricta de salud**
para controlar apps web y APIs: exige status exacto, cuerpo JSON esperado, sin
redirección a login y, opcionalmente, TLS válido.

No es un subsistema nuevo: reutiliza el scheduler, la base (PostgreSQL), el
`lib/url-guard.js` (anti-SSRF) y el sistema de avisos (push FCM + email SMTP con
destinatarios opt-in). La lógica de decisión vive aislada en `lib/health-check.js`.

## Cómo se mantiene activo con la PC del administrador apagada

Los chequeos corren **en el backend** (el server de Node en Railway), en un
`setInterval` que se arma al iniciar el proceso. **No dependen de ninguna PC de
administrador ni de que haya un navegador abierto**: con la PC del admin apagada
los controles siguen ejecutándose 24/7 mientras el servicio de Railway esté
levantado. El panel web sólo muestra lo que el backend ya midió.

La única dependencia es que el proceso backend esté corriendo. Ante un redeploy o
reinicio de Railway, el verificador vuelve a armarse solo; y si quedó un hueco
(el proceso estuvo caído/dormido un rato), se registra como **interrupción del
scheduler** (ver abajo) para no mostrar una medición vieja como si fuera actual.

## Los 3 controles de Linde/staging

Se siembran de forma **idempotente** al iniciar (bajo el primer usuario admin),
salvo que se defina `SEED_STAGING_CONTROLS=0`:

| Control | URL | JSON esperado |
|---|---|---|
| Web   | `https://web-staging-6538.up.railway.app/health/ready`   | `{"status":"ok","service":"web"}` |
| Admin | `https://admin-staging-33d1.up.railway.app/health/ready` | `{"status":"ok","service":"admin"}` |
| API   | `https://api-staging-46412.up.railway.app/health/ready`  | `{"status":"ok","service":"api"}` |

Config de cada uno: intervalo **300s** (5 min), timeout **10s**, status **200**,
`health_mode=true`, `enforce_tls=true`, `notify_down=true`. Idempotente: no se
recrea si ya existe (por URL); si se borra, reaparece en el próximo arranque.

## Qué valida cada chequeo

1. **Status exacto** (200, configurable). No alcanza "cualquier < 400".
2. **Cuerpo JSON** con los pares clave/valor indicados (`expected_json`), comparado
   por propiedad (sin depender del orden de claves). Una respuesta **HTML con 200
   NO es saludable** (no parsea como JSON → `json`).
3. **Sin redirección**: en `health_mode` NO se sigue la redirección (`maxRedirects=0`);
   cualquier 3xx (incluida la que va a un login) es **caída** `redireccion`, y no se
   conecta al destino.
4. **TLS real** (si `enforce_tls`): se **exige HTTPS** y se valida el certificado
   con `rejectUnauthorized:true` (cadena + **hostname** por SNI + **vigencia**). La
   validación TLS **no se desactiva**: un cert inválido tira error en el handshake
   y el chequeo da caída `tls`. (Los monitores sin `enforce_tls` siguen con
   `rejectUnauthorized:false`, porque un cert vencido lo vigila `ssl_monitors`.)
5. **Timeout** único que cubre también la **lectura del cuerpo** (un `/health` que
   queda sin terminar da `timeout`).
6. **Cuerpo acotado** (64 KB): si se excede, es caída `cuerpo_grande` (no se valida
   un cuerpo truncado como correcto). Nunca se almacena la respuesta completa.
7. **Clasificación de errores**: `dns`, `tls`, `timeout`, `conexion`, `ssrf`,
   `redireccion`, `http`, `json`, `cuerpo_grande` (en `last_error_kind` y en el historial).

Los monitores "clásicos" (sin `health_mode` ni `expected_json`) conservan la
regla histórica (sano = 2xx/3xx): no se cambió su comportamiento.

## Confirmación, incidentes y avisos

- **Reintento antes de alertar/abrir incidente**: una caída se confirma con
  `URL_CHECK_RETRIES=3` intentos separados `URL_CHECK_RETRY_DELAY_MS=15s` (hasta
  ~30s) antes de declararla. Filtra cortes transitorios.
- **Un solo incidente por caída confirmada** (`lib/url-incidents.js`): reutiliza la
  tabla `incidents` (`incidents.url_id`; `machine_id` queda NULL). Apertura
  idempotente (`INSERT … SELECT WHERE sigue caído AND NOT EXISTS uno abierto`): no
  duplica. Al recuperarse se **resuelve** (con duración) y se registra el evento.
- **Avisa al caer y al recuperarse**, sólo en la transición. **Deduplicado** por el
  cambio de estado. **Reintento de entrega**: el aviso queda `alert_pendiente` y se
  entrega con **reclamo atómico**; si la entrega falla, se revierte y se reintta en
  el próximo ciclo **sin duplicar** (mismo patrón que `lib/offline.js`).
- **Pausar o editar** un monitor **no** pasa por el checker → **no** se interpreta
  como recuperación (el incidente abierto sigue abierto; no se emite aviso 'up').
- Canales: push (FCM) + email (SMTP). Al dueño siempre; a destinatarios extra por
  el mecanismo opt-in (doble confirmación), ver abajo.

## Concurrencia y reinicios

- **Sin solapes / sin duplicados entre workers**: los vencidos se **reclaman de
  forma atómica** (`UPDATE … SET last_check=NOW() WHERE vencido RETURNING`), así dos
  instancias no chequean el mismo monitor. El aviso también se reclama atómico. Con
  una sola instancia, además, un guard en memoria evita solapar ciclos.
- **Tras un reinicio**: el verificador se re-arma solo al iniciar el proceso y los
  vencidos se recalculan por `last_check` en la base (la programación no se pierde).

## Estados mostrados (distinguir "sin comprobar" de "saludable")

`GET /api/url-monitors` devuelve, por monitor, un campo `estado`:

- **`sin_comprobar`** — nunca se chequeó (`last_check` NULL). No se muestra como sano.
- **`saludable`** — última medición OK y reciente.
- **`caido`** — última medición falló (con `last_error_kind`, `last_error` y
  `outage_seconds` = hace cuánto está caído).
- **`desactualizado`** — la última medición quedó vieja (más de ~2× el intervalo)
  o el verificador no está corriendo: **no** se presenta el dato viejo como actual.

### Interrupción del scheduler

En cada ciclo el verificador escribe `app_settings.url_checker_last_tick`. Si entre
ciclos pasa mucho más que el intervalo (proceso dormido, reinicio, redeploy), se
registra `app_settings.url_checker_last_gap` y se loguea un warning. Si el último
tick quedó viejo, la API marca `scheduler_pausado=true` y todos los monitores pasan
a `desactualizado`; el panel muestra un aviso ("el verificador no está corriendo").

## Destinatarios (sin inventar correos ni secretos en Git)

- SMTP se configura por **panel** (global, admin) o por usuario; las claves se
  **cifran en la base** (`enc:v1:`), nunca van a Git. Fallback por variables de
  entorno (`SMTP_HOST/USER/PASS/...`).
- Destinatarios extra por control: tabla `monitor_recipients` (opt-in con doble
  confirmación y link de baja). Se cargan por el endpoint/panel; **no se hardcodea
  ningún correo**.

## Seguridad

- **SSRF**: toda salida pasa por `lib/url-guard.js` — sólo http/https, sólo
  direcciones públicas, revalida cada redirección y conecta a la dirección ya
  validada (defensa anti DNS-rebinding). Las URLs que apunten a direcciones
  internas quedan "caídas" con el motivo y **no** se conecta.
- **Permisos**: los endpoints exigen `authenticateToken` y filtran por dueño
  (`WHERE user_id`); la config global es `requireAdmin`.

## Operación

- **Agregar/editar un control**: pestaña *URLs* → *Agregar URL* (o `POST/PUT
  /api/url-monitors`, que aceptan `health_mode`, `expected_json`, `enforce_tls`).
- **Ver historial**: `GET /api/url-monitors/:id/history` (botón *Historial*).
- **Ver incidentes** del control: `GET /api/url-monitors/:id/incidents`.
- **Desactivar la siembra automática** de los 3 controles: `SEED_STAGING_CONTROLS=0`.
- **Pausar/activar** un control: desde el menú de la fila (`is_active`).

## Pruebas realizadas (evidencia)

- `node --test` (sin tocar staging): **148/148**. Incluye:
  - `health-check.test.js` — 503, JSON inválido, JSON con valor distinto, servicio
    equivocado, redirección (seguida y NO seguida), **cuerpo grande**, timeout, DNS,
    TLS no confiable, conexión, SSRF, recuperación, status configurable, compat clásico.
  - `url-monitor.test.js` — integración contra un **mock HTTP local** (inyectando el
    validador, sin abrir bypass SSRF): 503, JSON malo, redirección, **no-seguir
    redirección (`maxRedirects=0`)**, timeout, caída→recuperación, cuerpo acotado,
    SSRF bloqueado.
  - `url-incidents.test.js` — contra Postgres real: **un solo incidente** por caída
    (idempotente), recuperación que lo resuelve, **reintento de entrega** que revierte
    sin duplicar, deduplicación, **concurrencia** (claim atómico → un aviso), pausar
    ≠ recuperación, recuperación antes de entregar la caída (sin aviso espurio).
  - `url-monitor-api.test.js` — API contra Postgres real: alta/edición health-check,
    estados, `scheduler_pausado`, `proxima_check`, endpoint de incidentes y
    **aislamiento** entre usuarios (401/404).
- **Chequeo real de solo-lectura** contra los 3 endpoints vivos de staging, con TLS
  **estricto** (`rejectUnauthorized:true`): los 3 dan 200, sin redirección, cert
  válido y JSON exacto (~230-340ms). No se detuvo staging en ningún momento.
- **Evidencia del scheduler** (server + Postgres reales): el verificador ejecutó una
  **medición real** de cada uno de los 3 (200, is_up, ~340ms, `proxima_check`
  computada). Demostración en vivo de **caída confirmada → un incidente** (service
  equivocado con 200 → `json`) y **recuperación → incidente resuelto** (duración).

## Dónde corre y con la PC del administrador apagada

- Los chequeos corren en el **backend de ServerEyes en Railway** (proceso Node;
  scheduler = `setInterval`). No dependen de ninguna PC de administrador ni de un
  navegador abierto: **siguen activos con la PC del admin apagada** mientras el
  servicio de Railway esté levantado. El panel sólo muestra lo ya medido.
- **Independencia de fallas — hallazgo**: los endpoints de Linde/staging son
  `*.up.railway.app` y **ServerEyes también corre en Railway** → **comparten
  proveedor**. Una caída a nivel Railway afectaría a ambos y ServerEyes no podría
  avisar. La vigilancia externa (del worker y de la antigüedad de backups) queda
  identificada como **etapa posterior** (no cubierta todavía).

## Límites y pendientes reales

- **NO está en monitoreo continuo activo en la instancia real**: el feature está
  construido y probado; **no se desplegó**. Haber creado registros o corrido un
  chequeo manual **no** equivale a monitoreo activo. Los 3 controles empiezan a
  correr cada 5 min recién **tras el deploy** a la instancia real.
- **Recepción real de notificaciones**: se validó el *envío* (push/email), el
  disparo, la deduplicación y el reintento de entrega, pero la **recepción real no
  se da por verificada** hasta confirmarla contra un buzón real (falta cargar el
  destinatario de prueba por el opt-in y que el entorno tenga SMTP configurado).
- **Multi-worker**: el reclamo atómico lo hace seguro si se escala; hoy la instancia
  corre con **1 réplica** (sin config de réplicas detectada).
- Display de "último chequeo" en el panel usa la hora del navegador; es correcto
  cuando el backend corre en UTC (Railway). El cálculo de `estado`/edad se hace en
  SQL, inmune a zona horaria.
