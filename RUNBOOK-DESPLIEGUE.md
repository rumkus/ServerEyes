# Runbook: despliegue del commit 629dc54

Guía operativa paso a paso. El detalle técnico de cada cambio está en
`SEGURIDAD-DESPLIEGUE.md`; esto es lo que se ejecuta, en orden, y cómo saber
si salió bien. Nada de lo marcado **[RAILWAY]**, **[PANEL]** o **[MÁQUINA]**
se hizo todavía: son acciones externas que requieren confirmación.

Etiquetas: **[LOCAL ✔]** ya comprobado en esta máquina · **[RAILWAY]** requiere
el dashboard/CLI de Railway · **[PANEL]** requiere el panel de admin de
ServerEyes · **[MÁQUINA]** requiere una máquina Windows de prueba.

## Estado de partida [LOCAL ✔]

- Commit local `629dc54` sobre `main`; árbol limpio; `origin/main` = `52b3744`
  (1 commit pendiente de push). El deploy activo en Railway es `52b3744`.
- Binarios (compilados de las fuentes de `629dc54`; hashes iguales a los del
  documento):
  - `C:\dev\ServerEyes\windows-agent\dist\ServerEyes-Agent-1.4.0.exe` —
    37 769 311 bytes — `98680938ea30604cb48ac61e137a537110c86e0dab900287497ef2163bafdfa0`
  - `C:\dev\ServerEyes\windows-client\dist\ServerEyes-Portable.exe` —
    93 156 875 bytes — `a6919485333e3156530b11a0160019ae6c751d2eca09497cc44d13aa0c6cb23b`
- Railway (lectura de configuración): servicio ServerEyes, rama `main`,
  `rootDirectory=/server`, 1 réplica, variables `DATABASE_URL`,
  `FIREBASE_SERVICE_ACCOUNT`, `JWT_SECRET`, `NODE_ENV`, `PORT`, `PUBLIC_URL`,
  `SMTP_ENC_KEY`. `TRUST_PROXY` no definida → rige el default `1`, que es
  un **supuesto pendiente de verificar** contra el proxy real (paso 5): si
  el edge de Railway no fuera exactamente un salto que agrega
  `X-Forwarded-For`, los límites por IP no serían fiables.
  `ipv6EgressEnabled=false`: los monitores solo alcanzan destinos con IPv4
  (ya era así; el guard prueba IPv4 primero).

## Precondiciones antes de tocar producción

- **Respaldo recuperable de PostgreSQL**: no hay `pg_dump` local; se toma con
  la imagen `postgres` de Docker, pasándole la URL por variable de entorno
  del contenedor (no por línea de comandos), a un archivo local fuera del
  repo. Se verifica que el archivo existe, su tamaño, y que contiene las
  tablas principales (`grep -c "CREATE TABLE"`). El respaldo contiene datos
  de clientes: queda en disco local y no se copia a ningún lado.
- **Vía de recuperación del servicio**: Railway → Deployments → Rollback al
  deploy `c898c9b9` (commit `52b3744`), o `railway redeploy` de ese deploy.
  Para la base: restaurar el dump con `psql` (misma imagen Docker) solo si
  hubiera pérdida de datos, cosa que ninguna migración de este despliegue
  puede causar (solo agrega columnas/índices).
- **Cómo se administra la contraseña real del rol**: en Railway la
  contraseña vive **dentro de PostgreSQL** (rol `postgres`); la variable
  `POSTGRES_PASSWORD` del servicio Postgres solo se usa al inicializar el
  volumen y para componer `DATABASE_URL`/`PGPASSWORD`. Cambiar la variable
  **no** cambia la contraseña del rol. La rotación real es `ALTER ROLE ...
  PASSWORD` dentro de la base **y después** actualizar la variable para que
  las URLs derivadas coincidan. Ver paso 1.

## Criterios de parada (aplican a todos los pasos)

Detenerse, conservar evidencia (logs sin secretos, salidas de consultas) y
**no** avanzar al paso siguiente si se observa cualquiera de estos:

- **Permisos**: un usuario ve, edita o encola algo de otro (máquina, monitor,
  comando); un endpoint de admin responde a un usuario común; `/api/pairing/
  status` entrega una clave sin `X-Pairing-Token`.
- **Migraciones**: falta alguna columna/índice esperado, sobra
  `remote_commands_reenvio_pendiente`, cambia el `count(*)` de
  `remote_commands`, o el log muestra `[FATAL]` / `Error al inicializar DB`.
- **Sesiones**: un token anterior al deploy deja de valer sin que cambie la
  contraseña (logout masivo no previsto), o un token revocado sigue entrando.
- **Comandos**: el mismo comando aparece ejecutado dos veces en la máquina de
  prueba (dos líneas `Comando remoto #N` con el mismo N en `servereyes.log`),
  o un comando `delivered` se reofrece solo.
- **Salud**: `/api/status` no responde en 2 minutos tras un deploy, o las
  máquinas pasan a offline en el panel sin haber apagado nada.

Recuperación: según el problema (ver cada paso). **No** hacer rollback si
eso reintroduce la vulnerabilidad del pairing sin motivo de salud, y **nunca**
restaurar la credencial rotada.

## Por qué este orden

Verificado leyendo el código del servidor desplegado (`52b3744`):

- Agente 1.4.0 y cliente 1.2.0 **contra el servidor viejo**: el autoupdate
  actual ya manda sha256 y firma (el 1.3.7 las exige), el heartbeat es el
  mismo, `/api/command-result` ignora el campo `status` nuevo, y si el server
  viejo reofrece un comando ya ejecutado, el registro del agente reenvía el
  resultado sin repetirlo. **Pueden actualizarse y seguir reportando.**
- Lo único que no funciona en el intervalo entre publicar binarios y
  desplegar el server es **vincular una máquina nueva** con el instalador
  1.4.0 (el server viejo no devuelve `pairing_token`; el instalador dice
  "servidor desactualizado" y termina). Con el orden inverso, el gap sería
  el simétrico (instaladores viejos contra server nuevo → 401). Por eso:
  binarios primero, server enseguida después, y no instalar máquinas nuevas
  en el medio.

## Paso 1 — Rotar la credencial de PostgreSQL [RAILWAY]

**Por qué**: la cadena de conexión estuvo en un archivo commiteado
(`server/test-heartbeat.js`, retirado en `095ea8d`); sigue en el historial.

Todo se hace desde un script local que lee la URL actual de `server/.env`,
genera la contraseña nueva y **nunca la imprime**; las variables de Railway
se setean con `railway variable set --stdin`.

1. Respaldo (precondiciones) verificado.
2. Identificar consumidores: variables del servicio Postgres que derivan de
   `POSTGRES_PASSWORD` (`DATABASE_URL`, `DATABASE_PUBLIC_URL`, `PGPASSWORD`) y
   `DATABASE_URL` del servicio ServerEyes (¿referencia `${{Postgres...}}` o
   literal?). Se comprueba con `railway variable list --json` filtrado por un
   script que solo imprime *si* es referencia, no el valor.
3. `ALTER ROLE postgres PASSWORD '<nueva>'` contra la base (conexión con la
   URL actual). Desde este momento las conexiones **nuevas** con la vieja
   fallan; las abiertas siguen.
4. Inmediatamente: `railway variable set --stdin POSTGRES_PASSWORD` en el
   servicio Postgres (Railway recompone sus URLs derivadas). Si la
   `DATABASE_URL` de ServerEyes es literal, setearla también con la nueva.
   Railway redespliega ServerEyes al cambiar su variable (referencia o
   literal).
5. Reescribir `DATABASE_URL=` en `server/.env` local.

**Esperado / comprobar**: conexión **nueva** con la URL nueva: `SELECT 1`
OK; conexión nueva con la URL vieja: rechazada (`password authentication
failed`). Deploy de ServerEyes `SUCCESS`, log con `Base de datos
inicializada`, `/api/status` 200.

**Detenerse si**: el `ALTER ROLE` falla (no se cambió nada: revisar y
reintentar); o si tras el ALTER el `variable set` falla → **prioridad**:
setear la variable a mano en el dashboard con la contraseña que el script
guardó en un archivo local (ver su salida), porque hasta entonces ServerEyes
no puede abrir conexiones nuevas. No restaurar la contraseña vieja.

## Paso 2 — Publicar los binarios [PANEL]

1. Panel de admin → **Agente** → elegir
   `C:\dev\ServerEyes\windows-agent\dist\ServerEyes-Agent-1.4.0.exe`. La
   versión se completa sola (`1.4.0`). Antes de confirmar, comparar el sha256
   que muestra el panel con `98680938…3bafdfa0`.
2. Panel de admin → **Client** → elegir
   `C:\dev\ServerEyes\windows-client\dist\ServerEyes-Portable.exe`, escribir
   versión `1.2.0` a mano, comparar sha256 con `a6919485…a6cb23b`.
3. **No instalar máquinas nuevas** hasta terminar el paso 3.

**Esperado / comprobar**: el panel lista 1.4.0 / 1.2.0 como versión actual.
En los ~2 minutos siguientes las máquinas online bajan el binario: en el log
del server aparece, una vez por hora, `[VERSIONES] … v1.4.0: N`; en cada
máquina, `servereyes.log` dice `Update a v1.4.0 aplicado correctamente` y los
latidos siguen (`Heartbeat OK … v1.4.0`). Confirmar con **una** máquina
antes de dar el paso por bueno.

**Detenerse si**: el hash no coincide (archivo equivocado: no publicar); o
una máquina queda en bucle/frenada (`[UPDATE] … se deja de ofrecer`): esa
máquina se actualiza a mano con el instalador, no bloquea el resto.
**Recuperar**: el panel tiene historial → "Volver a esta" republica 1.3.7 /
1.1.0; las máquinas que ya subieron **no bajan solas** (el autoupdate solo
ofrece versiones mayores) pero 1.4.0 es compatible con el server viejo, así
que no hace falta bajarlas.

## Paso 3 — Push y despliegue del servidor [RAILWAY] (hacer enseguida del 2)

Verificado: la rama que despliega es **`main`** y no hay gate de checks: el
push despliega.

1. `git -C C:\dev\ServerEyes log --oneline -1` debe mostrar `629dc54`.
2. `git -C C:\dev\ServerEyes push origin main`.
3. Railway → Deployments: esperar `SUCCESS` (build ~1 min).

**Esperado / comprobar**: log de arranque sin `[FATAL]`, con
`Base de datos inicializada`; `/api/status` 200. Los agentes ya en 1.4.0
siguen online (mirar el panel: ninguna máquina pasa a offline por el deploy;
el detector da 60 s de margen y el build+arranque tarda menos).

**Detenerse / recuperar**: si el deploy falla o `/api/status` no responde en
2 minutos → Railway → Deployments → **Rollback** al deploy `c898c9b9`
(`52b3744`). Es seguro: las migraciones solo agregan columnas/índices y
retiran un índice que el código viejo no usa. Límites del rollback: los
instaladores 1.4.0 no vinculan contra el server viejo (usar 1.3.7 para
vincular mientras dure), y un resultado `indeterminate` de un agente 1.4.0
lo mostraría como completado.

## Paso 4 — Migraciones y pruebas funcionales controladas [RAILWAY + MÁQUINA]

**Migraciones** (`psql` contra la base, solo lectura; la URL se toma del
dashboard, no se pega en ningún lado):

```sql
SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='session_version';
SELECT column_name FROM information_schema.columns WHERE table_name='remote_commands' AND column_name IN ('delivered_at','delivery_count','retry_of','idem_key');
SELECT indexname FROM pg_indexes WHERE tablename='remote_commands';
SELECT column_name FROM information_schema.columns WHERE table_name='ssl_monitors' AND column_name='last_error';
SELECT count(*) FROM remote_commands;
```

Esperado: 1 fila, 4 filas, la lista incluye `remote_commands_reenvio_idem` y
**no** `remote_commands_reenvio_pendiente`, 1 fila, y el `count` igual al de
antes del deploy. [LOCAL ✔] mismas sentencias probadas sobre base vacía y
sobre el esquema intermedio con datos.

**Funcionales** (cuenta de prueba propia + una máquina de prueba; nada de
esto toca máquinas de clientes):

| Prueba | Acción | Esperado |
|---|---|---|
| Login | entrar al panel web y a la app con la cuenta de prueba | entra; una sesión abierta antes del deploy sigue viva |
| Revocación | cambiar la contraseña desde la app | el panel web abierto vuelve al login con el aviso; la app sigue adentro; `POST /api/auth/logout-all` cierra todo |
| Pairing | instalar 1.4.0 en la máquina de prueba, tipear el código en la app | la máquina aparece online en <1 min; el log del agente muestra `VINCULADO` |
| Heartbeat | mirar la máquina en el panel | online, métricas actualizándose |
| Comandos | enviar `echo hola` | Pendiente → Entregado → Completado en ≤2 latidos. Luego: apagar el agente, enviar otro comando, prenderlo → queda **Entregado** sin resultado y no se repite; ↻ Reenviar pide escribir `REENVIAR` y crea uno nuevo "reenvío de #N" |
| Monitores | crear monitor web `http://127.0.0.1/` | 400 "destino no permitido"; con un sitio público, OK; editar un monitor SSL existente ya no da 500 |

**Detenerse si** alguna falla de forma que afecte a usuarios reales (login o
heartbeat) → rollback del paso 3. Si falla solo la prueba de comandos o
monitores, no hay urgencia: se corrige en un commit siguiente.

## Paso 5 — TRUST_PROXY y réplicas [RAILWAY]

- Réplicas: **1** (lectura de configuración hoy). Si algún día se sube, el
  pairing en memoria deja de funcionar: hay que llevarlo a Postgres antes.
- `TRUST_PROXY`: hoy no está definida y rige el default `1`. Eso es un
  **supuesto** hasta este paso: [LOCAL ✔] probado con un salto simulado y sin
  proxy; lo que falta es el proxy real. Con la cuenta de prueba logueada, desde una red cuya
  IP pública conozcas:

  ```
  curl -s -X POST https://servereyes.app/api/auth/logout-all -H "Authorization: Bearer <token de la cuenta de prueba>" -H "X-Forwarded-For: 1.2.3.4"
  ```

  y luego, en la base: `SELECT ip FROM audit_log WHERE action='logout_all' ORDER BY id DESC LIMIT 1;`

  Esperado: tu IP pública real. **Si aparece `1.2.3.4`**, el proxy no está
  agregando la cabecera o hay más saltos: definir `TRUST_PROXY` con el número
  correcto de saltos (o `0` y aceptar que los límites por IP del pairing sean
  globales) y redeploy. Hasta resolverlo, los límites por IP no son fiables
  (el resto del sistema no depende de ellos).

## Paso 6 — App móvil [LOCAL + tienda]

1. `cd mobile-final` → subir `versionCode`/`versionName` en
   `android/app/build.gradle` → `npm run android -- --mode=release` o el
   flujo de build habitual → APK/AAB.
2. Publicar por el canal habitual.

**Esperado**: cambiar la contraseña desde la app nueva mantiene la sesión en
ese dispositivo y muestra el aviso "sesiones en otros dispositivos
cerradas"; una sesión revocada muestra "Sesión cerrada" en vez de
"token expirado". Hasta publicarla, la app actual funciona (vuelve al login
sin el mensaje específico). No hay dependencia con los pasos anteriores.

## Qué queda como supuesto hasta hacerlo en producción

- Que el edge de Railway sea un salto y agregue `X-Forwarded-For` (paso 5).
- Que `DATABASE_URL` del servicio sea una referencia y no un literal (paso 1.2).
- Que el autoupdate real de una máquina 1.3.7 → 1.4.0 tarde lo esperado
  (probado el mecanismo, no en la flota).
