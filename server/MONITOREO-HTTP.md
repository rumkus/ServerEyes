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
2. **Cuerpo JSON** con los pares clave/valor indicados (`expected_json`).
3. **Sin redirección**: en `health_mode`, cualquier 3xx/redirección (p. ej. a un
   login) es **caída**, no "sano".
4. **TLS** (si `enforce_tls`): un certificado no confiable es caída.
5. **Clasificación de errores**: `dns`, `tls`, `timeout`, `conexion`, `ssrf`,
   `redireccion`, `http`, `json` (se guarda en `last_error_kind` y en el historial).

Los monitores "clásicos" (sin `health_mode` ni `expected_json`) conservan la
regla histórica (sano = 2xx/3xx): no se cambió su comportamiento.

## Confirmación, avisos y anti-repetición

- **Reintento antes de alertar**: una caída se confirma con `URL_CHECK_RETRIES=3`
  intentos separados `15s` antes de declararla (filtra cortes transitorios).
- **Avisa al caer y al recuperarse**, y **sólo al cambiar de estado**
  (`notify_down && wasUp !== isUp`): no repite la misma alerta en cada ciclo.
- Canales: push (FCM) + email (SMTP). Al dueño siempre; a destinatarios extra por
  el mecanismo opt-in (doble confirmación), ver abajo.

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
- **Ver historial**: botón *Historial* por fila (`GET /api/url-monitors/:id/history`).
- **Desactivar la siembra automática** de los 3 controles: `SEED_STAGING_CONTROLS=0`.
- **Pausar/activar** un control: desde el menú de la fila (`is_active`).

## Pruebas realizadas (evidencia)

- `node --test` (sin tocar staging): **134/134**. Incluye:
  - `health-check.test.js` — 503, JSON inválido, JSON con valor distinto,
    redirección a login, timeout, DNS, TLS no confiable, conexión, SSRF,
    recuperación, status configurable, compat clásico.
  - `url-monitor.test.js` — integración real contra un **mock HTTP local**
    (inyectando el validador, sin abrir bypass SSRF): 503, JSON malo, redirección,
    timeout, caída→recuperación, captura de cuerpo acotada, SSRF bloqueado.
  - `url-monitor-api.test.js` — API contra Postgres real: alta/edición con campos
    health-check, estado `sin_comprobar`/`saludable`/`caido`(+outage)/`desactualizado`
    y `scheduler_pausado`.
- **Chequeo real de solo-lectura** contra los 3 endpoints vivos de staging: los 3
  dan 200, sin redirección, TLS confiable y el JSON exacto (~400ms). No se detuvo
  staging en ningún momento.
- **Smoke test** del panel (server + Postgres reales): la vista *Monitores HTTP*
  renderiza estado, respuesta, "caído hace Xm", categoría de error y el aviso de
  scheduler pausado, sin errores de JS.

## Límites y pendientes reales

- **Recepción real de notificaciones**: se validó el *envío* (push/email) y la
  lógica de disparo, pero la **recepción real no se da por verificada** hasta
  confirmarla contra un buzón real (pendiente de cargar el destinatario por el
  mecanismo opt-in).
- **Despliegue**: el feature está construido y probado en local; **no se
  desplegó**. Los 3 controles empiezan a correr cada 5 min recién tras el deploy.
- Los incidentes formales siguen siendo de máquinas; para los controles HTTP el
  "historial de incidentes" se ve desde el historial de chequeos (`url_check_history`)
  y la duración de la caída (`outage_seconds`/`down_since`).
- Display de "último chequeo" en el panel usa la hora del navegador; es correcto
  cuando el backend corre en UTC (Railway). El cálculo de `estado` se hace en SQL,
  inmune a zona horaria.
