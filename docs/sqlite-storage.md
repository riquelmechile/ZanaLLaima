# Almacenamiento SQLite WAL · Fase 1

ZanaLLaima usa almacenamiento transaccional local basado en el módulo `node:sqlite` de Node.js 22.16+ (API experimental). No usa un servicio externo ni credenciales de proveedor.

## Estructura e invariantes

- Ruta por defecto: `.zana/state.sqlite`; la variable heredada `ZANA_STATE_FILE=.zana/state.json` sigue aceptada y se traduce a la ruta SQLite.
- `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=10000`, `foreign_keys=ON`, `user_version=5`.
- Una misión activa, unidades normalizadas por fila, revisión activa separada, recibos de trabajo y revisión con unicidad por token, eventos y revisiones históricas.
- `BEGIN IMMEDIATE` serializa las transiciones entre procesos y obliga a leer el estado después de adquirir el bloqueo. El token de cada ejecución protege de completados duplicados. La generación de intento y el contador de correcciones RDD se conservan en el estado; los reintentos de trabajo siguen las reglas de seguridad de la Fase 0.
- Los eventos recientes están limitados a 2000 registros y las revisiones archivadas a 200; los lectores acceden mediante paginación por cursor descendente.
- Los recibos de resultados se almacenan por separado. No existe limpieza automática de recibos, para evitar perder el registro de una ejecución.

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

El backup debe ser válido, del mismo esquema y no contener trabajo `RUNNING`. Los archivos anteriores se mueven a una ruta de cuarentena recuperable. El proceso guarda un marcador durante la operación; cualquier interrupción en ese punto requiere inspección del operador antes de volver a iniciar el servidor.

## Pruebas y límites

`npm test` verifica migración, recibos persistentes, transacciones fallidas, contenido archivado, contención entre procesos, rechazo de dobles completados, salida abrupta sin `COMMIT`, backup y restauración de corrupción simulada.

**La Fase 0 ya incluye controles locales de leases, reconciliación firmada y reintentos acotados**; ver [seguridad y ciclo de vida](safety-lifecycle.md). Sigue pendiente verificar su aplicación en el ejecutor real del anfitrión. Al reiniciar una unidad WRITE incierta, no relanzarla automáticamente.

El almacenamiento es local: no usarlo como base compartida por filesystem de red ni asumir fiabilidad de locking remoto. Mantener copias externas y probar el procedimiento de restauración antes de una operación crítica.

## Recuperación de una restauración interrumpida

Si se encuentra `.restore-pending`, **todos los comandos de lectura, historia y modificación rechazan el almacén**. El operador debe inspeccionar las rutas del archivo SQLite, sus posibles `-wal`/`-shm` y los archivos `.quarantine.*`, detener los clientes y validar una copia antes de retirar manualmente el marcador. No eliminar el marcador mientras haya un proceso activo o sin entender qué fase de restauración quedó pendiente.

Los tokens de ejecución se guardan en recibos internos. Los eventos de historial solo incluyen un resumen SHA-256 del token y las consultas de revisiones ocultan los tokens de paquetes. Las consultas MCP del almacén son de solo lectura; la restauración está reservada al CLI local.

Los tokens y generaciones de intento protegen de dobles completados. El heartbeat renovable y la recuperación controlada de READ están implementados. Ningún WRITE incierto se reintenta sin reconciliación firmada; su aplicación real por herramientas externas del anfitrión permanece pendiente de ZL-004.

## Versión 3 y revisiones verificadas

La migración de SQLite v2 a v3 agrega `review_count` para conservar el límite de cinco rondas RDD verificadas al reiniciar. Ejecutar `storage-migrate` con el almacén detenido antes de operaciones de solo lectura cuando exista una base anterior. El historial archivado sigue separado de la revisión activa. Ver [RDD sobre Git](solo-rdd.md).


## Versión 4: presupuestos durables de misión

La migración v3→v4 agrega `active_mission.budget` (JSON) sin modificar trabajo o historia previos. Misiones heredadas sin presupuesto no reciben una fecha de vencimiento retroactiva. Las nuevas misiones almacenan límites inmutables de tareas activas, reintentos, intentos acumulados, lease, tamaño de resultados, rondas RDD y duración máxima. Una transacción que intente alterar `budget`, exceder el contador global o persistir varios escritores activos se rechaza y se revierte íntegramente. La lectura de una base v3 exige ejecutar primero una transacción de migración autorizada; no asumir compatibilidad de lectura antes de actualizar.

Detalles y verificación reproducible en [Fase 4](phase4-performance.md).


## SQLite v5: registro durable de efectos WRITE

La nueva tabla `write_effect_receipts` conserva, de manera única por intento, el identificador de efecto, SHA pre/post, bytes y timestamp del archivo. Las intenciones quedan también en el `run.effectIntent` de la unidad. Un proceso que se detiene luego del efecto pero antes de confirmar la transacción del recibo deja `OUTCOME_UNKNOWN` persistido y no repetible. Las bases v4 se migran transaccionalmente a v5 antes de admitir nuevas escrituras. Ver [ZL-004](safety-lifecycle.md).
