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

## Adopción extraordinaria de una cuarentena sin diario

Si la base viva se perdió y existe una `.quarantine.<UUID>` antigua sin diario, el programa **nunca** la selecciona por mtime. Solo el operador, tras detener todos los clientes, puede escoger el UUID exacto:

```sh
ZANA_RESTORE_OFFLINE=1 node src/cli.mjs storage-adopt-quarantine <UUID> --confirm [--force-data-loss]
```

La operación requiere que no exista DB viva ni `.restore-pending`, verifica SQLite y hace checkpoint de WAL antes de publicar la DB de forma exclusiva. Fusiona las revocaciones y los nonces de **todas las cuarentenas y `.aborted.<UUID>` legibles** con las mismas comprobaciones monotónicas del restore. Después aplica una **barrera ciega**: revoca todos los grants y fija `restore_epoch` a la hora de adopción. Por eso la recuperación exige una **firma nueva del operador** para volver a autorizar WRITE: un GRANT previo no sirve aunque estuviera activo en la cuarentena antigua. La decisión queda registrada como `QUARANTINE_ADOPTED` antes de publicar. `storage-status` incluye revisión, fecha de actualización y cantidad de revocaciones por copia; inspeccionarlas antes de escoger UUID. Una copia ilegible puede contener historia no recuperable, y nunca se debe asumir que esa historia no existió. Restore, abort y cleanup comparten `.restore.lock` mediante `flock` entre procesos Linux. Si el guardia `flock` muere durante una operación, el operador termina con SIGKILL antes de continuar escribiendo; el diario permite recuperarlo. Si la DB y su cuarentena comparten dev/ino tras un crash entre `link` y `rm`, el siguiente adopt del mismo UUID solo completa el unlink y fsync.

## Recuperación de una restauración interrumpida

Si se encuentra `.restore-pending`, los comandos de datos rechazan el almacén hasta completar o abortar el diario. El reintento de restore auto-aborta el diario anterior cuando su integridad es comprobable. **Nunca borrar el marcador ni mover cuarentenas a mano.**

El comando **local** `node src/cli.mjs reconcile-view` muestra unidad, generación, ruta, SHA previo/esperado y token completo solo al operador. Ninguna herramienta MCP expone ese token. Los tokens de ejecución se guardan en recibos internos. Los eventos de historial solo incluyen un resumen SHA-256 del token y las consultas de revisiones ocultan los tokens de paquetes. Las consultas MCP del almacén son de solo lectura; la restauración está reservada al CLI local.

Los tokens y generaciones de intento protegen de dobles completados. El heartbeat renovable y la recuperación controlada de READ están implementados. Ningún WRITE incierto se reintenta sin reconciliación firmada; su aplicación real por herramientas externas del anfitrión permanece pendiente de ZL-004.

## Protocolo transaccional del diario de restauración

**Invariante:** nunca se instala una base que retroceda una revocación o permita reutilizar un nonce confirmado, ni se separan una base SQLite y su WAL con información pendiente. Antes de tocar la base viva o su cuarentena se exige el checkpoint exclusivo `PRAGMA wal_checkpoint(TRUNCATE)`: el WAL debe tener longitud cero, y una segunda conexión que impida el checkpoint bloquea la operación.

`.restore-pending` contiene JSON durable con los campos `version:1`, `id` (UUID), `path`, `temp`, `quarantine`, `phase`, `restoreOps` y `abortOps`. El campo booleano opcional `allowUnreadable` conserva el consentimiento de un restore forzado sobre DB corrupta y se reaplica durante abort después del crash; nunca autoriza desechar un WAL con datos sin checkpoint. Las rutas están limitadas al archivo de estado y sus sidecars `-wal`/`-shm`; `temp` debe tener el prefijo de restauración autorizado. El primer diario se escribe en un temporal `.restore-pending.new.<UUID>`, se hace fsync del contenido, se publica exclusivamente con enlace duro (`link`, falla si existe otro diario), se elimina el temporal y se hace fsync del directorio. Nunca se escribe primero un archivo marcador vacío. Un marcador legado vacío/truncado sin movimientos posibles y con la base viva intacta se puede abortar sin borrar archivos a mano.

**Estados y transición:**

- `phase: restoring`: cada operación en `restoreOps` avanza `pending → intent → done`. `intent` se persiste antes del rename, el directorio se sincroniza después y `done` se persiste antes del siguiente paso.
- `phase: aborting`: se infieren de forma conservadora los renames realizados y se genera `abortOps`; cada rollback también avanza `pending → intent → done`. El candidato instalado, si existe, queda en `.aborted.<UUID>`; la cuarentena se devuelve a la ruta original con sus sidecars.
- `infer()` concilia el diario con existencia de `from` y `to`: solo origen presente equivale a pendiente; solo destino presente implica rename realizado. Ambos presentes es ambiguo, ambos ausentes se rechaza. Si no hubo ningún movimiento, abort elimina **solo el marcador**.
- `storage-restore` ejecutado nuevamente después de SIGKILL primero intenta el abort del diario activo y solo después prepara un nuevo candidato. **Nunca** selecciona cuarentenas por fecha de modificación: solo el UUID del diario autoriza mover archivos.

**Diagnóstico y acciones del operador:**

| Código | Acción segura |
| --- | --- |
| `AMBIGUOUS_RENAME` | Ambas rutas del movimiento existen: detenerse, no sobrescribir ninguna. |
| `BLIND_RESTORE` | Sin DB previa, aceptar explícitamente --force-data-loss y revocación total. |
| `BUSY_BACKUP` | Trabajo RUNNING en backup; cerrar/reconciliar primero. |
| `CHECKPOINT_BUSY` | Otra conexión bloquea checkpoint exclusivo; cerrar clientes y reintentar. |
| `CHECKPOINT_MISSING` | Base esperada no encontrada; revisar estado del diario. |
| `CHECKPOINT_NONEMPTY` | WAL no vaciado; no mover SQLite hasta checkpoint completo. |
| `CONFIRM_REQUIRED` | Revisar consecuencias y repetir con --confirm si está autorizado. |
| `CONSUMED_BUDGET` | La DB viva tiene trabajo RUNNING, o su ledger de presupuesto (misión activa, misiones archivadas y ledger heredado de restores anteriores) registra más intentos o generaciones de lease que el backup para la misión del backup. Sin `--force-data-loss` el restore se rechaza; con él se conserva `max(viva, backup)` por unidad. |
| `EMPTY_BACKUP` | Backup sin misión activa; escoger copia válida. |
| `EMPTY_QUARANTINE` | No contiene misión activa; no adoptar. |
| `GRANT_COLLISION` | Conflicto de identidad de grant: bloquear e inspeccionar firmas y origen. |
| `INVALID_FORCE` | Pasar booleano forceDataLoss válido y explícito. |
| `INVALID_JOURNAL` | Diario corrupto: no borrar archivos; abort offline solo si no hubo movimientos identificables. |
| `INVALID_LEDGER` | El ledger `consumed_budget` (contadores que no son enteros ≥ 0, claves que no son strings de 1 a 200 caracteres) o un snapshot de `mission_archive` está corrupto. El **backup** se valida en todo restore, ciego incluido: si es él, escoger otra copia (`--force-data-loss` no lo publica). Si es la **DB viva** (ledger, snapshot archivado o contadores de una unidad activa dañados), `--force-data-loss` reconstruye su ledger desde las unidades válidas y omite las dañadas. Si es la **cuarentena a adoptar**, `--force-data-loss` lo reconstruye y mueve las filas archivadas corruptas a `mission_archive_corrupt`, así los restores siguientes no necesitan force. El resultado lo informa con `ledgerRebuilt: true`. |
| `INVALID_QUARANTINE` | UUID o identidad incompatible; no hacer renames manuales. |
| `INVALID_UUID` | Elegir UUID válido exacto de storage-status. |
| `JOURNAL_ACTIVE` | Completar o abortar diario activo, luego volver a operar. |
| `LIVE_PRESENT` | DB viva existente: no sustituirla; solo se completa un hardlink idéntico tras crash. |
| `LIVE_UNREADABLE` | DB viva corrupta: preservar y evaluar recuperación forzada con consentimiento. |
| `LOST_CANDIDATE` | Candidato perdido: abort debe devolver cuarentena intacta antes de reintentar. |
| `LOST_DATABASE` | Falta DB de cuarentena; preservar evidencia y no instalar una copia arbitraria. |
| `LOST_RENAME` | Faltan ambos extremos del movimiento; preservar temporales y consultar diario. |
| `NEWER_RECEIPT` | Backup omite recibos nuevos; escoger copia más completa o consentimiento de pérdida. |
| `NONCE_COLLISION` | Conflicto en nonce consumido: bloquear hasta investigar la trazabilidad. |
| `NOT_FOUND` | Cuarentena solicitada ausente; revisar el ID. |
| `NO_JOURNAL` | No hay restore interrumpido que abortar; confirmar estado antes de actuar. |
| `OFFLINE_REQUIRED` | Detener clientes y establecer ZANA_RESTORE_OFFLINE=1. |
| `QUARANTINE_UNREADABLE` | Cuarentena ilegible; abort e inspección, nunca inferir revocaciones ausentes. |
| `ROLLBACK_INCOMPLETE` | Abort incompleto: conservar diario, cerrar clientes y reintentar recuperación. |
| `SAME_SOURCE` | Backup igual a DB activa; elegir un origen diferente. |
| `SCHEMA` | Backup incompatible; usar versión migrable soportada. |
| `UNCERTAIN_WRITE` | Resolver WRITE OUTCOME_UNKNOWN mediante reconciliación firmada antes del restore. |
| `UNOWNED_ARTIFACTS` | No hay diario y faltó DB viva: inspeccionar las copias y adoptar manualmente UUID exacto con --confirm cuando corresponda. |
| `UNREADABLE_SOURCE` | Una cuarentena o `.aborted.*` hermana es ilegible (`UNREADABLE`: también una base de schema anterior), no es un archivo regular (`NOT_REGULAR`) o tiene el ledger corrupto (`INVALID_LEDGER`), y podría tener presupuesto consumido más nuevo. Inspeccionarla; adoptar igual solo con `--confirm --force-data-loss`, que registra la fuente omitida en `skippedSources` del evento y del resultado. |
| `UNREADABLE_WAL` | DB ilegible con WAL pendiente; preservar datos sin forzar descarte. |
| `UNSAFE_QUARANTINE` | Symlink, hardlink o tipo inseguro; conservar y revisar archivo. |
| `WAL_NOT_EMPTY` | WAL pendiente: cerrar conexiones y completar checkpoint, no separarlo de DB. |
| `flock timeout` | Otro proceso retiene el lock: cerrar clientes y reintentar luego, no borrar el archivo de lock. |

**Presupuesto consumido (R11).** Los `attempts` y la `leaseGeneration` de cada unidad son hechos monótonos, igual que los nonces: el total de starts es la suma de `attempts`, así que también lo es. Cada base guarda un ledger `consumed_budget` en `metadata`, por misión y unidad, que se fusiona siempre y nunca se achica: un restore normal fusiona la DB viva con el backup; un restore ciego y el `adopt` suman además todas las cuarentenas y copias `.aborted.*` legibles. Eso cubre el cambio de misión: restaurar otra misión B y luego el backup viejo de A no devuelve los intentos de A. Sin `--force-data-loss`, el restore se rechaza con `CONSUMED_BUDGET` si el backup tiene menos consumo que el ledger para su misión o si hay trabajo RUNNING; con `--force-data-loss`, y en el `adopt`, las unidades del candidato suben a `max`. La `revision` de la misión se fusiona en todo restore o adopt: queda por sobre la de cada fuente **legible**, aunque no haya consumo nuevo.

Límites, todos informados en el resultado del comando (`blind`, `ledgerRebuilt`, `skippedSources`):

- Si alguna fuente hermana es ilegible, el `adopt` se rechaza con `UNREADABLE_SOURCE` salvo `--force-data-loss`.
- Un restore **ciego** (DB viva ausente o ilegible, solo con `--force-data-loss`) fusiona el ledger de las copias `.aborted.*` y cuarentenas legibles y lista las ilegibles en `skippedSources`; el consumo que solo conocía la DB perdida se pierde. Lo mismo vale para el `adopt` de una cuarentena cuando la DB viva se perdió después de ella: es disaster recovery explícito (`--confirm`) y no puede conocer lo que la DB perdida consumió. Es la pérdida aceptada, igual que la revocación total de grants.
- Una unidad `OUTCOME_UNKNOWN` conserva su `leaseGeneration` exacta, para que su reconciliación firmada siga calzando; solo suben sus `attempts`. El ledger guarda igual la generación mayor, así que un backup posterior de esa misma unidad puede rechazarse con `CONSUMED_BUDGET` aunque no haya consumo nuevo; en ese caso usar `--force-data-loss`, que conserva el máximo.
- Si la fusión de historias divergentes deja el total de starts sobre `maxWorkStarts`, la misión ya no puede empezar trabajo nuevo, pero se puede cancelar, expirar y archivar: solo se rechaza una escritura que **sube** el total sobre el límite.
- Las rondas de revisión (`reviewCount` frente a `maxReviewRounds`) **no** están en el ledger: un restore las devuelve al valor del backup. Las revisiones pasan a GitHub en la fase remota; en el modo local es un límite aceptado.
- El ledger es una fila JSON en `metadata` y `mission_archive` no se poda: ambos crecen en forma lineal con las misiones archivadas y se leen en cada restore o adopt. No hay compactación.

**Modelo de amenaza.** El restore y el `adopt` son comandos offline del operador sobre el servidor. El backup es un artefacto del operador, no una entrada de un tercero: quien puede entregar un backup arbitrario también puede editar la base SQLite directamente, incluidos los límites de presupuesto de la misión. Estas reglas protegen contra **errores** de recuperación (devolver intentos consumidos sin darse cuenta) y contra datos corruptos, y validan el ledger para que un archivo dañado nunca anule el máximo. No autentican backups. En el modo remoto (MCP para ChatGPT) ningún host tiene acceso a estos comandos.


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
