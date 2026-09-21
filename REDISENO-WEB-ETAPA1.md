# Rediseño web — etapa 1 (dashboard NOC y navegación)

Rama de trabajo: **`codex/rediseno-web`** · commit **`34dc226`**
Punto de restauración: commit **`672b9f2`** (en `main`), etiqueta
**`backup/antes-rediseno-web-20260921`** (anotada, apunta a `672b9f2`).

Sin push, sin deploy, sin cambios en producción.

## Cómo volver al punto anterior SIN perder el rediseño

El rediseño está en su propia rama; para descartarlo alcanza con cambiar de
rama, sin borrar nada y sin `git reset --hard`.

```
# Volver al estado previo (main, = punto de restauración):
git checkout main

# Retomar el rediseño cuando quieras:
git checkout codex/rediseno-web
```

- El trabajo del rediseño queda guardado en `codex/rediseno-web` (commit
  `34dc226`); cambiar de rama no lo pierde.
- Si en el futuro el rediseño ya se hubiera integrado a `main` y se quisiera
  deshacer, **no** reescribir historia: usar un commit de reversión
  (`git revert 34dc226`), que anula los cambios dejándolos en el historial.
- La etiqueta `backup/antes-rediseno-web-20260921` marca el punto exacto por
  si hiciera falta compararlo (`git diff backup/antes-rediseno-web-20260921`).

## Vista previa local (datos ficticios)

`node C:\gtmp\se-preview\mock-server.js` → **http://127.0.0.1:4599/**
(login: cualquier email/clave). Sirve el `index.html` real con el rediseño y
responde `/api/*` con datos inventados (5 servidores, 1 offline, alertas de
umbral, 3 monitores HTTP con uno caído, sin geolocalización). **No** usa la
base ni el `.env` de producción; las escrituras se ignoran.

## Alcance de esta etapa

Solo NOC + shell compartido (sidebar, topbar, indicadores, tabla, tema,
tokens de color, iconos). Las demás vistas (URLs, Uptime, Certificados,
Incidentes, Ajustes, Inventario, admin, app móvil) conservan su contenido
bajo el shell nuevo y se rediseñarán en etapas siguientes.

---

# Rediseño web — etapa 2 (Monitores HTTP y SSL)

Commit de esta etapa: sobre `codex/rediseno-web`, encima de la etapa 1
(`34dc226`). Mismo estilo del NOC aprobado (tokens, tipografía, iconos SVG,
bordes en vez de sombras).

## Qué cambió (solo `server/public/index.html`)
- **Pestañas** dentro de "Monitores": HTTP y Certificados SSL, con contador por
  tipo e indicadores propios de cada uno (altura fija, compactos).
- **HTTP**: buscador (nombre/dominio) + filtros por estado real de la API
  (Todos / Activos / Caídos / Pausados). Tabla con nombre/dominio, respuesta,
  último chequeo y estado en pill legible (UP / DOWN / Pausado / Sin chequear).
- **Acciones**: Historial visible; secundarias (Editar, Pausar/Activar,
  Verificar SSL) en un menú ⋯; Eliminar separado y en rojo, con su confirmación.
- **SSL**: tarjetas ordenadas por urgencia (vencido → por vencer → error →
  sin chequear → vigente), con dominio, estado, vencimiento y días restantes.
  "Error de consulta" y "Sin chequear" se muestran distinto de un certificado
  válido: nunca se pintan como sanos sin datos.
- **Historial HTTP**: período visible (rango de fechas), evolución de latencia
  (SVG con los datos disponibles, cortando la línea en las caídas), tiles de
  uptime/caídas/pasajeros/respuesta y la tabla de detalle con el filtro
  Todos/Solo fallos. No se inventan datos históricos.
- **Estados** de carga (spinner), vacío (con guía) y error preparados.
- **Accesibilidad**: `role=tablist/tab/menu`, `aria-label`/`aria-selected`,
  foco visible; Escape cierra menús (devolviendo el foco al disparador) y
  diálogos (devolviendo el foco al control que los abrió); click fuera cierra
  los menús. Mejora compartida: manejador global de Escape para modales.
- FAB de soporte: espacio de scroll extra en móvil para que no tape la última
  fila de acciones.

Se conservaron: selección múltiple, destinatarios y sus confirmaciones,
edición, pausa, eliminación, verificación SSL, y los vínculos HTTP↔SSL
(“vigilar su certificado” / “vigilar que responda”). No se tocaron endpoints,
permisos, autenticación ni lógica de monitoreo.

## Vista previa
`node C:\gtmp\se-preview\mock-server.js` → http://127.0.0.1:4599/ (login:
cualquiera). Ahora el mock incluye HTTP saludable/caído/pausado/lento/sin-chequear
y SSL vigente/por-vencer/vencido/error/sin-datos, y las operaciones
(crear/editar/pausar/eliminar/verificar) **actualizan el estado en memoria**.

## Cómo volver a la etapa 1 sin perder la etapa 2
La etapa 2 es un commit propio sobre la rama; para ver solo la etapa 1:
```
git checkout 34dc226        # etapa 1 (dashboard NOC)
git checkout codex/rediseno-web  # volver a la punta con HTTP/SSL
```
(La rama conserva ambos commits; cambiar de commit no pierde trabajo.)

---

# Rediseño web — etapa 3 (Incidentes, Reportes e Inventario)

Commit de esta etapa: sobre `codex/rediseno-web`, encima de la etapa 2
(`01d7de5`). Mismo estilo aprobado (tokens, tipografía, iconos SVG, paneles con
borde, indicadores compactos de altura fija, tablas anchas, menús ⋯ para
acciones secundarias con la destructiva separada en rojo).

## Qué cambió (solo `server/public/index.html`)
- **Incidentes**: los abiertos se priorizan por antigüedad (el que lleva más
  tiempo, primero) y se marca su gravedad con un acento en el borde según cuánto
  llevan abiertos (rojo ≥2 h, ámbar ≥30 min, verde recién). La gravedad se
  **deriva de datos existentes** (tiempo abierto): no se inventó ningún campo de
  severidad en el backend. Cada fila muestra recurso afectado, inicio, duración
  y estado con jerarquía clara. Se conservan el detalle, la cronología de
  eventos, la resolución con notas, y las acciones "Agregar nota"/"Resolver"
  (con sus confirmaciones y permisos). Tiles de resumen (abiertos, +2 h,
  resueltos, total) y estados de carga/vacío.
- **Reportes**: se agrupan por propósito (Estado del parque / Incidentes /
  Inventario) con chips de filtro. Solo se ofrecen los reportes que el backend
  realmente genera —CSV de servidores, PDF del parque, PDF de incidentes, CSV de
  inventario— sin inventar períodos ni tipos que la API ignora; cada tarjeta lo
  aclara ("Estado actual"). Se conservan `exportCSV`/`exportPDF` y la exportación
  de incidentes/inventario.
- **Inventario**: tabla legible para buscar y comparar (con buscador por
  nombre/IP/serie/CPU/SO) + detalle por categorías (Identificación, Sistema,
  Procesador y memoria, Discos, Red, Placas, Archivo hosts). Se **distingue** el
  dato ausente (en cursiva, "Sin dato") del dato real, y un relevamiento de más
  de 3 días se marca como **desactualizado**. Los tres estados
  (relevada / sin relevar / no se releva) se ven distintos. Se conserva la
  descarga de la planilla CSV con su aviso cuando no hay nada que exportar.

## Pendientes de la etapa 2, cerrados
- **Teclado**: probado en navegador real. Las filas de incidentes son
  `role="button"` y se abren con Enter/Espacio; el foco es visible; en Monitores
  el menú ⋯ abre y **Escape lo cierra devolviendo el foco al disparador**
  (verificado). Escape también cierra diálogos devolviendo el foco.
- **FAB de soporte**: se reserva una **banda derecha permanente** (76 px en
  escritorio, 52 px en móvil) donde flota el botón, de modo que **nunca tapa
  filas ni acciones en ninguna posición del scroll**. No es sólo espacio al
  final. Para que las tablas anchas no invadan esa banda en móvil, cada tabla
  de datos scrollea dentro de su panel (recortada a la izquierda del FAB) y la
  tabla de monitores entra ajustando el texto; el grid principal usa
  `minmax(0,1fr)` + `min-width:0` para que los paneles respeten la banda.
  Verificado sin solapamientos a 1440/1280 y 375, en ambos temas, en las 8
  vistas y en el tope del scroll.

## Vista previa
`node C:\gtmp\se-preview\mock-server.js` → http://127.0.0.1:4599/ (login:
cualquiera). El mock ahora sirve incidentes ficticios (abiertos y resueltos con
cronología), inventario como **arreglo de máquinas con `.inventory`** cubriendo
relevada/sin-relevar/no-aplica y un caso desactualizado, y exportaciones válidas
(CSV de servidores e inventario, PDF/HTML del parque e incidentes). Resolver un
incidente, agregar una nota, etc. **actualizan el estado en memoria**.

## Cómo volver a la etapa 2 sin perder la etapa 3
La etapa 3 es un commit propio sobre la rama; para ver solo la etapa 2:
```
git checkout 01d7de5             # etapa 2 (Monitores HTTP/SSL)
git checkout codex/rediseno-web  # volver a la punta con etapa 3
```
(La rama conserva los tres commits; cambiar de commit no pierde trabajo.)
