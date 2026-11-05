# Almacenamiento SQLite WAL · Fase 1

ZanaLLaima usa almacenamiento transaccional local basado en el módulo `node:sqlite` de Node.js 22.16+ (API experimental). No usa un servicio externo ni credenciales de proveedor.

## Estructura e invariantes

- Ruta por defecto: `.zana/state.sqlite`; la variable heredada `ZANA_STATE_FILE=.zana/state.json` sigue aceptada y se traduce a la ruta SQLite.
- `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=10000`, `foreign_keys=ON`, `user_version=6`.
- Una misión activa, unidades normalizadas por fila, revisión activa separada, recibos de trabajo y revisión con unicidad por token, eventos y revisiones históricas.
- `BEGIN IMMEDIATE` serializa las transiciones entre procesos y obliga a leer el estado después de adquirir el bloqueo. El token de cada ejecución protege de completados duplicados. La generación de intento y el contador de correcciones RDD se conservan en el estado; los reintentos de trabajo siguen las reglas de seguridad de la Fase 0.
- Los eventos recientes están limitados a 2000 registros y las revisiones archivadas a 200; los lectores acceden mediante paginación por cursor descendente.
- Los recibos de trabajo y WRITE se retienen como evidencia durable. Los recibos de revisión se conservan mientras su revisión esté activa o dentro de las últimas 200 archivadas; `trimHistory()` purga recibos de revisión huérfanos que salen de esta retención.

## Migración desde JSON

1. Detener clientes antiguos que sigan escribiendo el JSON.
2. Ejecutar `node src/cli.mjs storage-status` para consultar el origen.
3. Ejecutar `node src/cli.mjs storage-migrate` con el mismo `ZANA_STATE_FILE`.
4. Comprobar `node src/cli.mjs storage-status` y `node src/cli.mjs status`.

La primera transacción también puede importar el JSON automáticamente. Antes de migrar se crea `state.json.pre-sqlite.bak`; se conserva el JSON original sin sobreescritura ni eliminación. Si existe una copia anterior de distinto contenido, se rechaza la migración hasta reconciliarla.

## Copia de seguridad y restauración

```sh
node src/cli.mjs storage-backup /ruta/backup-nuevo.sqlite
node src/cli.mjs storage-history 25
node src/cli.mjs storage-reviews 25
```

La copia usa la API de backup de SQLite sobre una vista transaccional consistente, valida `quick_check`, y no sobreescribe destinos existentes.

Para recuperar una base dañada o volver a un backup, **detener primero todos los clientes y procesos que puedan escribir o leer el almacén**. La restauración exige confirmación por variable de entorno:

```sh
ZANA_RESTORE_OFFLINE=1 node src/cli.mjs storage-restore /ruta/backup.sqlite
```

El backup debe ser válido, migrable al esquema actual (v1 a v6) y no contener trabajo `RUNNING`. Una restauración ciega sin base viva exige `--force-data-loss`, revoca todos los grants recuperados y registra un epoch que rechaza acciones firmadas antes de restaurar. Los archivos anteriores se mueven a una ruta de cuarentena recuperable. El proceso utiliza un diario JSON fsync; tras una interrupción, ejecutar abort offline o reintentar restore, que primero concilia el diario. `storage-status` enumera `.restoring.*` y `.quarantine.*` huérfanos y reporta errores de temporales WRITE sin bloquear una reconciliación firmada.

## Pruebas y límites

`npm test` verifica migración, recibos persistentes, transacciones fallidas, contenido archivado, contención entre procesos, rechazo de dobles completados, salida abrupta sin `COMMIT`, backup y restauración de corrupción simulada.

**La Fase 0 ya incluye controles locales de leases, reconciliación firmada y reintentos acotados**; ver [seguridad y ciclo de vida](safety-lifecycle.md). Sigue pendiente verificar su aplicación en el ejecutor real del anfitrión. Al reiniciar una unidad WRITE incierta, no relanzarla automáticamente.

El almacenamiento es local: no usarlo como base compartida por filesystem de red ni asumir fiabilidad de locking remoto. Mantener copias externas y probar el procedimiento de restauración antes de una operación crítica.

## Recuperación de una restauración interrumpida

Si se encuentra `.restore-pending`, los comandos de datos rechazan el almacén hasta completar o abortar el diario. El reintento de restore auto-aborta el diario anterior cuando su integridad es comprobable. **Nunca borrar el marcador ni mover cuarentenas a mano.**

El comando **local** `node src/cli.mjs reconcile-view` muestra unidad, generación, ruta, SHA previo/esperado y token completo solo al operador. Ninguna herramienta MCP expone ese token. Los tokens de ejecución se guardan en recibos internos. Los eventos de historial solo incluyen un resumen SHA-256 del token y las consultas de revisiones ocultan los tokens de paquetes. Las consultas MCP del almacén son de solo lectura; la restauración está reservada al CLI local.

Los tokens y generaciones de intento protegen de dobles completados. El heartbeat renovable y la recuperación controlada de READ están implementados. Ningún WRITE incierto se reintenta sin reconciliación firmada; su aplicación real por herramientas externas del anfitrión permanece pendiente de ZL-004.

## Protocolo transaccional del diario de restauración

**Invariante:** nunca se instala una base que retroceda una revocación o permita reutilizar un nonce confirmado, ni se separan una base SQLite y su WAL con información pendiente. Antes de tocar la base viva o su cuarentena se exige el checkpoint exclusivo `PRAGMA wal_checkpoint(TRUNCATE)`: el WAL debe tener longitud cero, y una segunda conexión que impida el checkpoint bloquea la operación.

`.restore-pending` contiene JSON durable con los campos `version:1`, `id` (UUID), `path`, `temp`, `quarantine`, `phase`, `restoreOps` y `abortOps`. Las rutas están limitadas al archivo de estado y sus sidecars `-wal`/`-shm`; `temp` debe tener el prefijo de restauración autorizado. El primer diario se escribe en un temporal `.restore-pending.new.<UUID>`, se hace fsync del contenido, se publica exclusivamente con enlace duro (`link`, falla si existe otro diario), se elimina el temporal y se hace fsync del directorio. Nunca se escribe primero un archivo marcador vacío. Un marcador legado vacío/truncado sin movimientos posibles y con la base viva intacta se puede abortar sin borrar archivos a mano.

**Estados y transición:**

- `phase: restoring`: cada operación en `restoreOps` avanza `pending → intent → done`. `intent` se persiste antes del rename, el directorio se sincroniza después y `done` se persiste antes del siguiente paso.
- `phase: aborting`: se infieren de forma conservadora los renames realizados y se genera `abortOps`; cada rollback también avanza `pending → intent → done`. El candidato instalado, si existe, queda en `.aborted.<UUID>`; la cuarentena se devuelve a la ruta original con sus sidecars.
- `infer()` concilia el diario con existencia de `from` y `to`: solo origen presente equivale a pendiente; solo destino presente implica rename realizado. Ambos presentes es ambiguo, ambos ausentes se rechaza. Si no hubo ningún movimiento, abort elimina **solo el marcador**.
- `storage-restore` ejecutado nuevamente después de SIGKILL primero intenta el abort del diario activo y solo después prepara un nuevo candidato. **Nunca** selecciona cuarentenas por fecha de modificación: solo el UUID del diario autoriza mover archivos.

**Diagnóstico y acciones del operador:**

| Código | Acción segura |
| --- | --- |
| `INVALID_JOURNAL` | No modificar archivos a mano. Si la base sigue intacta y no hubo movimientos, usar abort offline; de lo contrario conservar evidencia y revisar. |
| `LOST_RENAME` / `LOST_DATABASE` / `LOST_CANDIDATE` | Falta una ruta del diario. Preservar cuarentena y temporales, comparar identidad y no forzar instalación de una base incompleta. |
| `AMBIGUOUS_RENAME` | Ambos extremos del rename existen: no sobrescribir ni elegir por fecha; inspección manual. |
| `UNOWNED_ARTIFACTS` | Existen restos sin diario dueño. No se adoptan automáticamente ni se omiten las revocaciones. |
| `JOURNAL_ACTIVE` | Detener procesos concurrentes y completar o abortar el diario antes de restaurar o limpiar. |

Comandos de operador, con todos los clientes cerrados:

```sh
ZANA_RESTORE_OFFLINE=1 node src/cli.mjs storage-status
ZANA_RESTORE_OFFLINE=1 node src/cli.mjs storage-restore-abort
ZANA_RESTORE_OFFLINE=1 node src/cli.mjs storage-restore /ruta/backup.sqlite
ZANA_RESTORE_OFFLINE=1 node src/cli.mjs storage-cleanup-artifacts --confirm
```

`storage-status` enumera `restoring`, `quarantines`, `aborted`, `journal` y temporales `.restore-pending.new.*`. La limpieza confirmada elimina solo candidatos/aborted/temporales ya huérfanos, nunca las cuarentenas que pueden contener los últimos permisos y nonces. `reconcile-view` expone los tokens completos exclusivamente en CLI local; el MCP nunca los muestra. Los conflictos de recuperación se resuelven antes de autorizar nuevas acciones.

## Versión 3 y revisiones verificadas

La migración de SQLite v2 a v3 agrega `review_count` para conservar el límite de cinco rondas RDD verificadas al reiniciar. Ejecutar `storage-migrate` con el almacén detenido antes de operaciones de solo lectura cuando exista una base anterior. El historial archivado sigue separado de la revisión activa. Ver [RDD sobre Git](solo-rdd.md).


## Versión 4: presupuestos durables de misión

La migración v3→v4 agrega `active_mission.budget` (JSON) sin modificar trabajo o historia previos. Misiones heredadas sin presupuesto no reciben una fecha de vencimiento retroactiva. Las nuevas misiones almacenan límites inmutables de tareas activas, reintentos, intentos acumulados, lease, tamaño de resultados, rondas RDD y duración máxima. Una transacción que intente alterar `budget`, exceder el contador global o persistir varios escritores activos se rechaza y se revierte íntegramente. La lectura de una base v3 exige ejecutar primero una transacción de migración autorizada; no asumir compatibilidad de lectura antes de actualizar.

Detalles y verificación reproducible en [Fase 4](phase4-performance.md).


## SQLite v5: registro durable de efectos WRITE

La nueva tabla `write_effect_receipts` conserva, de manera única por intento, el identificador de efecto, SHA pre/post, bytes y timestamp del archivo. Las intenciones quedan también en el `run.effectIntent` de la unidad. Un proceso que se detiene luego del efecto pero antes de confirmar la transacción del recibo deja `OUTCOME_UNKNOWN` persistido y no repetible. Las bases v4 se migran transaccionalmente a v5 antes de admitir nuevas escrituras. Ver [ZL-004](safety-lifecycle.md).


## SQLite v6: modos POSIX en recibos WRITE

La migración conservadora v5→v6 añade \`pre_mode INTEGER\` y \`post_mode INTEGER\` a \`write_effect_receipts\`, sin reescribir los recibos anteriores. En filas históricas estos campos permanecen **NULL**, porque no sería correcto inferir los permisos originales a partir del hash del archivo. En cada recibo nuevo, \`pre_mode\` registra los permisos completos del destino anterior (\`st.mode & 0o7777\`) y \`post_mode\` los permisos efectivamente aplicados; para borrados, el modo posterior es \`NULL\`.

El almacenamiento sigue preservando el hash, token, generación y evidencia del efecto; el esquema objetivo actual es **\`user_version=6\`**. Una base v5 requiere su migración mediante una transacción de escritura autorizada antes de lecturas nuevas. Ver \`tests/schema-v6-migration.test.mjs\` y \`tests/write-effect.test.mjs\`.
