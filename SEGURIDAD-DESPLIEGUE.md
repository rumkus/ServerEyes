# Correcciones de seguridad: qué cambia y cómo desplegarlo

Cubre cinco cambios: credencial de PostgreSQL en un script, vinculación de
agentes, destinos de monitores web, revocación de sesiones y comandos remotos.

## Pasos de despliegue (para el operador, en este orden)

Nada de esto lo hace el código solo. Ninguno de estos pasos se ejecutó desde
esta sesión.

### A. Rotar la credencial de PostgreSQL (antes de cualquier otra cosa)

`server/test-heartbeat.js` tenía la cadena de conexión de producción escrita
adentro y estuvo en el historial de git (se quitó del índice en `095ea8d`,
pero los commits anteriores siguen en el remoto y en cualquier clon).
Quitarla del archivo **no la revoca**. No se reescribió el historial; si se
quiere hacerlo es una decisión aparte (obliga a re-clonar).

1. En Railway → proyecto → servicio **Postgres** → Variables: cambiar
   `POSTGRES_PASSWORD` (o regenerar credenciales según lo que ofrezca el
   panel). Anotar la nueva `DATABASE_URL` que Railway expone.
2. Actualizar **todos los consumidores** de la credencial vieja:
   - Servicio **ServerEyes** en Railway: variable `DATABASE_URL` (si está
     referenciada como `${{Postgres.DATABASE_URL}}` se actualiza sola; si está
     copiada a mano, pegarla de nuevo). Redeploy.
   - `server/.env` en la máquina de desarrollo: contiene la vieja; reemplazar.
   - Cualquier otro lugar donde se haya pegado (clientes SQL, scripts,
     `TEST_DATABASE_URL` si alguna vez apuntó allí, gestores de contraseñas).
3. Verificar que la vieja ya no conecta (`psql "<url vieja>"` debe fallar) y
   que el servicio arrancó con la nueva (`/api/status` responde y el log dice
   `Base de datos inicializada`).

### B. Publicar los binarios nuevos (antes del servidor)

Artefactos ya compilados desde el código de este commit (no publicados):

| Artefacto | Ruta | Tamaño | SHA-256 |
|---|---|---|---|
| Agente 1.4.0 | `C:\dev\ServerEyes\windows-agent\dist\ServerEyes-Agent-1.4.0.exe` | 37 769 311 bytes | `98680938ea30604cb48ac61e137a537110c86e0dab900287497ef2163bafdfa0` |
| Cliente 1.2.0 | `C:\dev\ServerEyes\windows-client\dist\ServerEyes-Portable.exe` | 93 156 875 bytes | `a6919485333e3156530b11a0160019ae6c751d2eca09497cc44d13aa0c6cb23b` |

Verificado sobre esos archivos: el agente responde `--version` → `1.4.0`
ejecutado desde una carpeta vacía y su snapshot incluye `comandos.js`; el
portable del cliente, extraído con 7za, contiene el mismo `app.asar` que el
build desempaquetado (mismo SHA-256), con `comandos.js`, `package.json`
1.2.0 y `CLIENT_VERSION = '1.2.0'`. Para recompilar: `npm run build` en cada
carpeta (los `dist/` no se versionan).

1. Panel de admin → **Agente** → subir `ServerEyes-Agent-1.4.0.exe`. La
   versión se completa sola desde el nombre; comparar el sha256 que muestra el
   panel con el de la tabla antes de confirmar.
2. Panel de admin → **Client** → subir `ServerEyes-Portable.exe`, escribir la
   versión `1.2.0` a mano (el nombre no la lleva) y comparar el sha256.
3. En la hora siguiente, la línea `[VERSIONES]` del log del server muestra
   cuántas máquinas online ya están en 1.4.0. Las que no prendan en 5 ofertas
   quedan frenadas (`[UPDATE] ... se deja de ofrecer`) y se actualizan a mano.

### C. Desplegar el servidor

1. Variables en el servicio ServerEyes: `JWT_SECRET` (ya existe), `TRUST_PROXY`
   sin definir o `=1` (Railway), opcionalmente `PAIRING_MAX_POR_IP`.
   **No** copiar `TRUST_PROXY=0` de `.env.example` a Railway.
2. Push a `main` (Railway despliega). Las migraciones corren solas en
   `initDB()` al arrancar; son idempotentes (probado sobre base vacía y sobre
   el esquema intermedio con datos).
3. **Comprobar las migraciones** (con `psql` contra la base de producción,
   solo lectura):
   ```sql
   SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='session_version';
   SELECT column_name FROM information_schema.columns WHERE table_name='remote_commands' AND column_name IN ('delivered_at','delivery_count','retry_of','idem_key');
   SELECT indexname FROM pg_indexes WHERE tablename='remote_commands';  -- debe estar remote_commands_reenvio_idem y NO remote_commands_reenvio_pendiente
   SELECT column_name FROM information_schema.columns WHERE table_name='ssl_monitors' AND column_name='last_error';
   SELECT count(*) FROM remote_commands;  -- igual que antes del despliegue
   ```
   En el log: `Base de datos inicializada` y ningún `[FATAL]`.
4. **Verificación funcional** (cuenta de prueba propia, agente de prueba):
   - Login web y en la app: entra; un token emitido antes del despliegue
     sigue valiendo (no se fuerza re-login).
   - Revocación: cambiar la contraseña desde la app → el panel web abierto con
     la sesión vieja vuelve al login con el aviso; la app sigue adentro con el
     token nuevo. `POST /api/auth/logout-all` cierra todo.
   - Pairing: instalador 1.4.0 → código en pantalla → confirmar en la app →
     el agente guarda la clave y empieza a latir. Con un instalador viejo
     (≤1.3.7) el `status` da `401 Falta el header X-Pairing-Token` (esperado).
   - Heartbeat: la máquina figura online; `curl -H 'X-Forwarded-For: 1.2.3.4'`
     no altera la IP registrada (ver TRUST_PROXY más abajo).
   - Comandos: `echo hola` → pasa de Pendiente → Entregado → Completado en
     dos latidos; apagar el agente, enviar un comando, prenderlo → queda
     Entregado sin resultado y **no se repite**; ↻ Reenviar pide `REENVIAR` y
     crea otro con "reenvío de #N".
   - Monitores: crear un monitor web con `http://127.0.0.1/` → 400; con un
     sitio público → OK; `/api/ssl-check` con `localhost` → 400; un monitor SSL
     existente se puede editar (antes daba 500).
5. Verificación de `TRUST_PROXY` (sección "trust proxy": es lo único que
   quedó como supuesto).

### C-bis. Si el despliegue sale mal

- **Rollback del servidor** (Railway → deployments → volver al anterior, o
  revertir el commit). Es seguro respecto de la base: las migraciones solo
  **agregan** columnas/índices y retiran un índice que el código anterior no
  usaba; el server anterior ignora las columnas nuevas. Lo que se pierde al
  volver:
  - los agentes 1.4.0 mandan `status` en `/api/command-result`; el server
    viejo lo ignora y marca `completed` (un `indeterminate` se vería como
    completado, con el texto `[INDETERMINADO]` en la salida);
  - el server viejo vuelve a entregar comandos `pending` sin reserva atómica
    (comportamiento previo);
  - los tokens emitidos por el server nuevo llevan `sv`; el viejo los acepta
    (no lo mira);
  - el pairing viejo vuelve a entregar la clave con el código solo (la
    vulnerabilidad original) y **los instaladores 1.4.0 no pueden vincular**
    contra él (esperan `pairing_token`): vincular con un instalador viejo
    mientras dure el rollback.
- **Rollback de binarios**: el panel tiene historial y "Volver a esta", pero
  el autoupdate solo ofrece versiones **mayores** a la instalada: un agente ya
  en 1.4.0 **no baja solo** a 1.3.7. Si hiciera falta volver, es reinstalar a
  mano con el instalador viejo. En la práctica no hace falta: 1.4.0 es
  compatible con el server anterior (ver arriba). `servereyes-comandos.json`
  queda en disco y el agente viejo lo ignora.
- **Migración a medias**: no aplica; cada sentencia es idempotente y
  `initDB` se puede volver a correr reiniciando el servicio.
- **Un agente que no prende tras el update**: el freno de 5 ofertas lo deja
  quieto en su versión; se actualiza a mano con el instalador.

### D. App móvil (cuando corresponda)

Recompilar y publicar el APK con los cambios de `mobile-final/App.tsx`
(sesión revocada con mensaje, token nuevo tras cambiar contraseña). Hasta
entonces la app actual funciona: una sesión revocada la manda al login como
"token expirado".

## Variables de entorno

| Variable | Obligatoria | Para qué |
|---|---|---|
| `JWT_SECRET` | sí (ya lo era) | firma de sesiones |
| `TEST_DATABASE_URL` | solo para tests | base de **pruebas** para `npm test` y `test-heartbeat.js`. Sin fallback a `DATABASE_URL`; si apunta a Railway, se aborta. |
| `TRUST_PROXY` | no (default `1`) | proxies de confianza delante del servidor. Ver "trust proxy". |
| `PAIRING_MAX_POR_IP` | no (default `20`) | pedidos de código de vinculación por IP cada 10 min. |

Ver `server/.env.example`.

## Migraciones

Todas corren solas en `initDB()` al arrancar, son `IF NOT EXISTS` y no tocan
datos existentes:

- `users.session_version INTEGER DEFAULT 1`
- `remote_commands.delivered_at TIMESTAMP`, `remote_commands.delivery_count INTEGER DEFAULT 0`, `remote_commands.retry_of INTEGER`
- `remote_commands.idem_key VARCHAR(64)` + índice único
  `remote_commands_reenvio_idem (user_id, retry_of, idem_key)`: clave de
  idempotencia de cada reenvío
- `DROP INDEX IF EXISTS remote_commands_reenvio_pendiente`: retira el índice
  parcial de una versión intermedia (no publicada, pero pudo correr en alguna
  base). Probado en `test/migracion.test.js`: base con ese esquema y comandos
  en varios estados → el índice se va, el nuevo aparece, las filas quedan
  idénticas; repetir la migración no cambia nada; base vacía termina con el
  mismo esquema.
- `ssl_monitors.last_error TEXT`
- Orden corregido en `initDB`: cuatro `ALTER TABLE ... ADD COLUMN` estaban
  **antes** del `CREATE TABLE` de su tabla (dos nuevos y dos preexistentes:
  `ssl_monitors.notify_emails`, `support_tickets.hidden_by_user`). Con
  `.catch(() => {})` fallaban en silencio y una base nueva quedaba sin esas
  columnas. En producción las tablas ya existen, así que no cambia nada; en
  una base nueva ahora arranca completa (verificado: suite entera en verde a
  la primera contra un Postgres recién creado).
- Además, columnas y una tabla que el código usaba pero `initDB` nunca creaba
  (`uptime_log`, `users.fcm_token`, `machines.grupo/orden/ping_ms/download_mbps/speed_test_at/previous_public_ip/ip_changed_at/ip_change_seen/dns_update_url/dns_host/dns_last_update`).
  En producción ya existen; se agregan para que una base nueva arranque.

## 1. Credencial en `test-heartbeat.js`

- La conexión sale de `TEST_DATABASE_URL`, sin fallback. El script rechaza
  URLs de Railway.
- Se quitó de `.gitignore` (el motivo para ignorarlo era la credencial). Ahora
  se versiona sin secretos.
- Uso: `TEST_DATABASE_URL=postgresql://usuario:clave@localhost:5432/servereyes_test node server/test-heartbeat.js`

## 2. Vinculación de agentes (`server/lib/pairing.js`)

Antes, el código de 6 dígitos visible en pantalla bastaba para consultar
`/api/pairing/status/:code` y llevarse la `machine_key`. Ahora:

- `POST /api/pairing/request` devuelve `{ code, pairing_token, expires_in }`.
  `pairing_token` son 32 bytes aleatorios (`crypto.randomBytes`) y solo lo
  conoce el proceso que pidió el código.
- `GET /api/pairing/status/:code` exige el header `X-Pairing-Token`. Sin él o
  con uno equivocado: 401. Cuando está confirmado, la respuesta trae la
  `machine_key`.
- **Tokens equivocados no anulan nada.** Quien vea el código en pantalla y
  bombardee con tokens falsos recibe 429 sobre *sus* consultas (30/min por
  código), pero ni invalida el código ni consume el cupo del agente legítimo:
  los contadores de tokens equivocados y de consultas legítimas son
  independientes (primero se compara el token, después se cuenta). Adivinar el
  token real (32 bytes aleatorios) no es viable. Probado con 50 tokens falsos
  seguidos y recuperación posterior con el legítimo, respetando su propio
  límite de frecuencia y el vencimiento.
- **Respuesta perdida:** que el servidor haya enviado la respuesta no prueba
  que el agente la recibió. Por eso el mismo `pairing_token` recupera la
  misma clave **todas las veces que haga falta** mientras el código siga
  vigente (5 min desde el pedido, con una gracia de 2 min después de
  confirmar para que una confirmación a último momento no deje al agente sin
  tiempo). Al vencer, desaparece y ni el token válido lo recupera. Hay dos
  límites de frecuencia independientes, ninguno anula el código: consultas
  con token correcto (120/min por código; el agente pregunta cada 2 s) y
  consultas con token equivocado (30/min por código). El código visible solo
  no sirve en ningún momento. Probado: 8 respuestas perdidas seguidas y recuperación posterior,
  vencimiento, token incorrecto, tope de frecuencia (`test/pairing.test.js`,
  `test/integracion.test.js`, `test/integracion2.test.js`).
- `POST /api/pairing/confirm` ya no devuelve la `machine_key` a la app (no la
  necesita). Es atómico: dos confirmaciones simultáneas crean una sola máquina.
  Un usuario que prueba códigos al azar queda frenado (8 fallos / 10 min).
- Códigos vencen a los 5 minutos; pedidos limitados por IP
  (`PAIRING_MAX_POR_IP`, default 20 / 10 min).
- **No hay fallback**: un agente viejo que no mande el token no puede vincular.

### trust proxy y límites

`TRUST_PROXY` controla cuántos saltos de `X-Forwarded-For` se creen. Lo que
está **verificado** y lo que es **supuesto** son cosas distintas:

- **Verificado (`TRUST_PROXY=1`, `test/integracion2.test.js`)**: la prueba
  simula la topología *cliente → un proxy que agrega la IP real al final de
  `X-Forwarded-For` → servidor*. El cliente de prueba conecta directo al
  servidor y manda la cabecera ya con la forma que dejaría ese proxy
  (`<lo que escribió el cliente>, <IP real>`). Con `1`, Express toma la
  última entrada; 20 pedidos con distinto prefijo falsificado y la misma IP
  final llegan al 429, y otra IP final tiene cupo propio.
- **Verificado (`TRUST_PROXY=0`, `test/integracion3-sinproxy.test.js`)**:
  sin proxy, la cabecera se ignora por completo; `req.ip` es la del socket y
  el cupo es uno solo por conexión de origen, diga lo que diga la cabecera.
- **Supuesto, pendiente de comprobar en Railway**: que el edge de Railway sea
  exactamente **un** salto y que **agregue** (no confíe ni deje pasar) la
  cabecera. Es lo que documenta Railway, pero **no está probado contra el
  proxy real desde esta sesión**. Cómo comprobarlo tras el despliegue (paso
  C.4): con un usuario de prueba logueado, desde una red conocida:
  `curl -H 'X-Forwarded-For: 1.2.3.4' -H 'Authorization: Bearer <token>' -X POST https://servereyes.app/api/auth/logout-all`
  y mirar en `audit_log` la fila `logout_all`: la columna `ip` tiene que ser
  la IP pública real de esa red, no `1.2.3.4`. Si apareciera `1.2.3.4`, hay
  más saltos o el proxy no agrega: ajustar `TRUST_PROXY` (número de saltos o
  lista de redes) antes de confiar en los límites por IP.
- **Fuera de esos supuestos, `X-Forwarded-For` no es fiable**: con un valor
  mayor al número real de saltos, o con un proxy que reenvía la cabecera sin
  agregar, cualquier cliente elige su `req.ip` y los límites por IP y la
  auditoría dejan de valer.
- **Ejecución local sin proxy**: `TRUST_PROXY=0` en `server/.env` (está en
  `.env.example`). No usar `1` en local.
### Pairing en memoria: limitaciones y recuperación ante fallos

- Los códigos, tokens y contadores **viven en memoria de cada instancia**.
  Con una sola réplica (la situación actual) funciona. Con más de una: el
  `request` del agente y sus `status` pueden caer en instancias distintas y
  la vinculación falla con 404; los límites por IP y por usuario se
  multiplican por la cantidad de réplicas. Antes de escalar hay que mover el
  store a Postgres (o fijar afinidad por conexión).
- **Reinicio o redeploy del servidor** durante una vinculación: se pierde el
  código. El agente ve 404 y termina; se vuelve a ejecutar el instalador y se
  pide un código nuevo. Si la confirmación ya había creado la máquina en la
  base pero el agente no llegó a retirar la clave, esa máquina queda huérfana
  (sin agente); se borra desde el panel y se vincula de nuevo.
- **Respuesta perdida** entre servidor y agente: cubierta (el mismo token la
  recupera hasta el vencimiento).
- **Código vencido** (5 min + 2 de gracia tras confirmar): el agente recibe
  404 y hay que pedir otro. La máquina creada al confirmar queda huérfana
  como en el caso anterior.

### Clientes actualizados

- `windows-agent/agent.js` (1.4.0) y `windows-client/main.js` (1.2.0):
  guardan el token en memoria y lo mandan en cada consulta. El token no va al
  log ni a la ventana de la UI.
- La app móvil no cambia: sigue mandando solo el código.
- El agente Linux no usa pairing (se le carga la clave a mano).

### Orden de despliegue

La vinculación solo ocurre al instalar un agente; los ya instalados no la
usan, así que **los agentes en producción no se ven afectados**.

1. Compilar y **publicar** agente 1.4.0 y cliente 1.2.0 desde el panel.
2. Desplegar el servidor.
3. Desde ese momento, para vincular una máquina nueva hay que usar el
   instalador 1.4.0 / cliente 1.2.0. Un instalador viejo recibe
   `401: Falta el header X-Pairing-Token. Actualiza el agente.`

Si se despliega el servidor primero, lo único que deja de funcionar hasta
publicar los binarios es vincular máquinas nuevas con instaladores viejos.

## 3. Destinos de monitores web (`server/lib/url-guard.js`)

- Solo `http:` y `https:`. Sin usuario/contraseña en la URL. Sin `localhost`.
- Se rechazan direcciones no públicas IPv4 (loopback, 10/8, 172.16/12,
  192.168/16, 169.254/16 incluido el endpoint de metadatos, CGNAT, multicast,
  reservadas, TEST-NET) e IPv6 (`::1`, `::`, ULA `fc00::/7`, link-local,
  multicast, documentación, Teredo, y las IPv4 embebidas: mapeadas
  `::ffff:x`, NAT64, 6to4).
- Un nombre se resuelve una sola vez; si **alguna** de sus direcciones es
  privada se rechaza. La conexión usa las direcciones **ya validadas** (lookup
  fijo pasado a `http.request`), no una segunda resolución: eso cierra el DNS
  rebinding. Se prueban en orden, IPv4 primero; si una no tiene ruta
  (`ENETUNREACH`/`EHOSTUNREACH`, típico de un host con AAAA y un servidor sin
  salida IPv6) se pasa a la siguiente validada. Reemplaza al
  `autoSelectFamily` que tenía la versión anterior, que con lookup fijo ya no
  aplicaba. Un `ECONNREFUSED` o un timeout no se reintentan.
- Cada redirección pasa por la misma validación antes de conectar.
- Se valida al crear (`POST /api/url-monitors`), al editar (`PUT`), al
  aprobar un cambio propuesto por un técnico (`pending-changes/:id/approve`,
  que además marca el cambio como rechazado si el destino no es válido) y en
  **cada chequeo**: una URL guardada antes de este cambio que apunte adentro
  queda como caída con `last_error = "Destino no permitido: ..."` y nunca se
  conecta.
- No hay opción de bypass. `followRedirects` acepta un validador inyectable
  solo por parámetro interno, que usan los tests; `server.js` nunca lo pasa.
- **Monitores SSL** (`/api/ssl-check`, `POST`/`PUT /api/ssl-monitors` y el
  chequeo periódico `revisarCertificados`) pasan por el mismo validador vía
  `urlGuard.inspeccionarCertificado`: el host se resuelve una vez, se rechaza
  si apunta adentro, y el handshake va a **esa** dirección (`host: address`)
  con el hostname original en `servername` (SNI). `rejectUnauthorized: false`
  para poder leer certificados vencidos o con cadena rota (es lo que un
  monitor SSL tiene que ver); no se envía ningún dato. Los registros
  guardados antes que apunten adentro quedan con `last_status = 'error'` y
  el motivo en `last_error`, sin conectar. `/api/ssl-check` devuelve además
  `chain_ok`/`chain_error`.
- Arreglado de paso: `PUT /api/ssl-monitors/:id` armaba los placeholders sin
  `$` (`alert_days = 1`) y devolvía 500 siempre.

## 4. Sesiones (`server/lib/sesiones.js`)

- Cada JWT lleva `sv` (session_version del usuario al emitirlo). En cada
  request se compara con la actual; si no coincide: `401 { code: "SESSION_REVOKED" }`.
- Sube la versión: `POST /api/auth/change-password` (devuelve un token nuevo
  para quien hizo el cambio), `POST /api/admin/reset-password`, y el nuevo
  `POST /api/auth/logout-all`.
- **Qué pasa con las sesiones existentes al desplegar:** nada. Los tokens
  emitidos antes no traen `sv` y se toman como versión 1, que es con la que
  arrancan todos los usuarios. Nadie tiene que volver a loguearse. En cuanto
  un usuario cambie su contraseña (o el admin se la resetee), todos sus tokens
  anteriores, incluidos los de antes de la migración, dejan de valer.
- Bloqueo de cuenta (`is_blocked`) ya se verificaba en cada request; no cambia.

### Clientes

- App móvil: `apiRequest` detecta `SESSION_REVOKED`, borra el token (también
  el biométrico) y muestra "Sesión cerrada". Al cambiar la contraseña adopta
  el token nuevo, así el propio dispositivo no queda afuera.
- Panel web: `api()` detecta `SESSION_REVOKED`, hace logout y muestra el
  motivo en la pantalla de login.
- Panel admin: ya hacía logout ante 401.
- La app móvil **no se recompiló**; el cambio queda para el próximo build.
  Hasta entonces, una sesión revocada en la app actual se comporta como
  "token expirado" (vuelve al login sin el mensaje específico).

## 5. Comandos remotos (`server/lib/comandos.js`, `windows-agent/comandos.js`)

### Servidor

- Estados: `pending → delivered → completed | failed | indeterminate`.
- La entrega es **atómica** (`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
  SKIP LOCKED) RETURNING`): dos latidos solapados no se llevan el mismo comando.
- Un comando entregado **no se vuelve a ofrecer**. Si el agente lo perdió
  (se cortó la red después de reservar), queda `delivered` sin resultado; el
  panel lo muestra como "Entregado" con la explicación.
- **Cómo se detecta y resuelve un estado desconocido:** en el panel, un
  comando `Entregado` que no pasa a `Completado` en un par de latidos, o uno
  `Indeterminado`, es un comando cuyo resultado el servidor no conoce: **puede
  seguir ejecutándose** o haber terminado sin que llegara el aviso. El usuario
  revisa en la máquina y, si decide repetirlo, usa **↻ Reenviar**
  (`POST /api/commands/:id/retry`), que crea **otra ejecución**: un comando
  nuevo con el mismo texto (id nuevo, `retry_of` apunta al original), así el
  registro del agente no lo confunde con el anterior y el original queda como
  historia. Nunca se reencola solo.
  - Confirmación: para `delivered` e `indeterminate` el panel exige escribir
    `REENVIAR` y explica que si la original corrió el efecto se duplica; para
    `failed` (el agente no pudo lanzar el proceso) basta un confirmar.
  - Autorización: solo el dueño de la máquina (404 para otros). Estados:
    `delivered`, `failed`, `indeterminate`; `pending`/`completed` → 409.
  - Auditoría: `audit_log` con `action = remote_command_retry`, `target_id` =
    comando nuevo, `details` con el original, su estado y el texto.
  - Idempotencia: `POST /api/commands/:id/retry` exige el header
    `Idempotency-Key` (8–64 chars `[A-Za-z0-9_-]`; sin él, 400). Orden de
    comprobaciones: **dueño de la máquina → clave → estado del original**; la
    búsqueda por clave va antes del chequeo de estado, así un reintento HTTP
    devuelve el comando ya creado aunque el original haya pasado a
    `completed` mientras tanto (probado). El panel genera una clave **por
    confirmación** y la repite cuando desconoce el resultado: sin respuesta
    (`status 0`) **o error 5xx** de un intermediario (el edge pudo cortar
    después de crear el comando); nunca genera una clave nueva por su cuenta.
    Un 4xx es respuesta definitiva y se muestra. La clave se persiste en
    `remote_commands` y es única por `(usuario, comando original, clave)`: la
    misma clave devuelve el **mismo** comando (`duplicado: true`) en
    cualquier estado. Una confirmación nueva trae otra clave y crea otro
    comando, que es lo que el usuario pidió.
    Probado: el escenario confirmar → crear → agente retira → respuesta
    perdida → reintento con la misma clave (mismo id, también tras
    `completed`); 5 POST simultáneos con la misma clave → un solo comando;
    claves distintas simultáneas → uno cada una; misma clave sobre otro
    original → otro comando; clave inválida → 400.
- `POST /api/command-result` acepta `status` (`completed|failed|indeterminate`)
  y es **idempotente**: un reenvío del mismo resultado responde 200 sin pisar
  lo guardado. Solo acepta resultados de la máquina dueña del comando.

### Agente y cliente

- Registro persistente `servereyes-comandos.json` (agente) / `comandos.json`
  en `userData` (cliente), escrito atómicamente. Cada comando se anota
  **antes** de ejecutarse.
- Si falla el envío del resultado, se reenvía en cada latido siguiente **sin
  volver a ejecutar** (hasta 50 intentos; un 404 del servidor lo da por cerrado).
- Un latido a la vez (`heartbeatEnCurso`) y un `Set` de ids en curso: el mismo
  comando no corre dos veces en paralelo aunque el servidor lo repitiera.
- Al arrancar, lo que quedó en `ejecutando` se informa como `indeterminate`
  con un texto explícito y **no se repite**.
- **Lo que no se garantiza:** "exactamente una vez". Si el proceso muere entre
  terminar de ejecutar y anotar `listo`, el comando se informa indeterminado
  aunque haya corrido; si muere entre reservar en el servidor y anotar en el
  registro, queda `delivered` sin rastro en el agente. En ambos casos no se
  repite solo.

### Compatibilidad (probada en `test/integracion2.test.js`)

- Servidor nuevo + agente viejo (≤1.3.7 / cliente ≤1.1.0): la reserva, la
  firma HMAC y la recepción del resultado funcionan igual. El agente viejo
  manda `output` sin `status` → se registra `completed`; si repite el envío,
  el servidor responde 200 sin pisar el primero.
- Lo que el agente viejo **no** hace y requiere actualizar a 1.4.0 / 1.2.0:
  reenviar un resultado cuyo envío falló (lo pierde: queda `delivered`),
  informar `indeterminate` tras un reinicio (queda `delivered`), evitar
  ejecutar dos veces si dos latidos se solapan (el servidor ya lo impide con
  la reserva atómica, así que en la práctica no ocurre), y vincular máquinas
  nuevas (pairing con token).
- Servidor viejo + agente nuevo: funciona; el servidor ignora `status`.
- `windows-agent/comandos.js` y `windows-client/comandos.js` son el mismo
  archivo duplicado (pkg y electron-builder empaquetan solo su carpeta).

### Empaquetado verificado

- Agente: `npm run build` (pkg 5.8.1, node18-win-x64) generó
  `dist/ServerEyes-Agent-1.4.0.exe`; el snapshot contiene
  `windows-agent\comandos.js` y el `.exe` ejecutado **desde una carpeta vacía**
  responde `--version` → `1.4.0` (el `require('./comandos')` está al inicio
  del archivo: si faltara, no arrancaría). Se agregó el flag `--version`.
- Cliente: `electron-builder --win --dir` generó `dist/win-unpacked`; `asar
  list` de `app.asar` incluye `comandos.js`, `main.js`, `preload.js`,
  `pairing.html`, `config.html`.
- Los `dist/` están en `.gitignore`; los binarios no se versionan.

## Qué está probado localmente y qué queda pendiente en producción

| Área | Probado localmente (esta sesión) | Pendiente en producción |
|---|---|---|
| Migraciones | base vacía; esquema intermedio con datos; repetición | correr contra la base real (paso C.2–C.3) |
| Pairing | protocolo completo, tokens falsos, respuesta perdida, vencimiento, límites por IP y por código | vincular una máquina real con el instalador 1.4.0 |
| Sesiones | revocación por cambio/reseteo/logout-all, tokens legados, clientes web y móvil (código; la app sin recompilar) | recompilar y publicar la app móvil |
| Comandos | reserva atómica, idempotencia de resultado y de reenvío, agente viejo, reinicio, registro del agente | comando real contra un agente 1.4.0 |
| Monitores | SSRF v4/v6, redirects, rebinding, SSL con cert vencido, fallback sin ruta IPv6 | — |
| TRUST_PROXY | dos topologías simuladas (1 salto / sin proxy) | comprobar el proxy real de Railway (C.5) |
| Binarios | compilados y verificados (versión, `comandos.js`, hash) | publicar desde el panel |
| Credencial de Postgres | eliminada del código | **rotar** (paso A) |

## Pruebas

```
cd server && npm test                       # sin base: 32 puras (+21 de integración/migración salteadas)
TEST_DATABASE_URL=... npm test              # con base de pruebas: 53
cd windows-agent && npm test                # 8 del registro de comandos
```

`test/migracion.test.js` **borra y recrea el esquema** de la base de pruebas:
otra razón para que `TEST_DATABASE_URL` nunca apunte a nada real.

`server.js` exporta `detener()`: cancela los temporizadores de la aplicación
(registrados con `cadaTanto`/`dentroDe`), cierra Firebase y el pool. Los tests
cierran el servidor HTTP y llaman a `detener()`; el proceso termina solo, sin
`process.exit` ni demoras. Un test que falla hace que `npm test` salga con
código distinto de cero (verificado con un fallo deliberado, con y sin base).

Los archivos de integración corren en serie (`--test-concurrency=1`): comparten
la base y cada uno la trunca. La prueba de SSL genera un certificado vencido
con `openssl` al vuelo (se salta si no está instalado).

La integración levanta `server.js` contra `TEST_DATABASE_URL` en un puerto
libre y **trunca las tablas** entre pruebas: nunca apuntarla a una base real.
Para correrlas localmente alcanza con un Postgres descartable, por ejemplo:

```
docker run -d --name servereyes-test-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=servereyes_test -p 55434:5432 postgres:16-alpine
TEST_DATABASE_URL=postgresql://postgres:x@127.0.0.1:55434/servereyes_test npm test
```
