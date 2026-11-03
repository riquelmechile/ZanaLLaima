# Almacenamiento SQLite WAL · Fase 1

ZanaLLaima usa almacenamiento transaccional local basado en el módulo `node:sqlite` de Node.js 22.16+ (API experimental). No usa un servicio externo ni credenciales de proveedor.

## Estructura e invariantes

- Ruta por defecto: `.zana/state.sqlite`; la variable heredada `ZANA_STATE_FILE=.zana/state.json` sigue aceptada y se traduce a la ruta SQLite.
- `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=10000`, `foreign_keys=ON`, `user_version=1`.
- Una misión activa, unidades normalizadas por fila, revisión activa separada, recibos de trabajo y revisión con unicidad por token, eventos y revisiones históricas.
- `BEGIN IMMEDIATE` serializa las transiciones entre procesos y obliga a leer el estado después de adquirir el bloqueo. El token de cada ejecución protege de completados duplicados. La generación de intento se conserva en el estado, pero su renovación segura depende del ciclo de vida pendiente de la Fase 0.
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

La generación inicial de intento y los tokens protegen de dobles completados. No hay todavía renovación de leases ni reintentos automáticos seguros; ese procedimiento depende de la Fase 0.
