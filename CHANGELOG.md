# Registro de cambios

## [0.3.3] - No publicado

- **P2, evidencia RDD Git de submódulos anidados:** además de inspeccionar los flags de índice de cada gitlink, \`observeGit()\` consulta el estado de cada worktree con \`--ignore-submodules=none\`, propagando cualquier cambio hasta la raíz. Corrige ocultación de contenido en un segundo nivel con \`submodule.inner.ignore=all\`.
- **Regresión negativa:** repositorios Git reales \`root/lib/inner\`, configuración de ignorar cambios solo en \`lib\`, modificación rastreada dentro de \`inner\` y rechazo de la comparación contra el candidato congelado.
- Sin release ni aprobación. \`keys/ci-verifier.pub\` permanece placeholder, el gate \`releaseAuthorized\` continúa falso y la atestación CI auténtica queda pendiente del operador.

## [0.3.2] - No publicado

- P1 seguridad: intención WRITE vinculada al grant original y test negativo de revocación más regrant.
- P2 seguridad: rechazo de flags ocultos Git assume-unchanged y skip-worktree en RDD.
- P2 seguridad adicional: inspección forzada de contenido de submódulos ignorados, con prueba Git real.
- Script humano idempotente para firma CI con --dry-run; atestación desactivada hasta revisión.
- Preflight distingue llave pública válida de placeholder sin dar autorización de release.
- Checklist humano para invitación, atestación, E2E y merge manual.

No hubo merge, tag ni despliegue.

## [0.3.1] - No publicado

Correcciones tras revisión del bot de GitHub sobre `a36120b4d0a03f61445dbfcff32e382390e95e14`. Cuatro commits independientes, sin merge, tag, release ni deploy.

### Corregido

- **P1, SQLite (0dfbc8d):** cola asíncrona por ruta absoluta de base de datos antes de abrir y bloquear las transacciones. Comparte la exclusión local con autorizaciones y archivado; libera la cola incluso tras errores. Pruebas de espera de 200 ms, ocho mutaciones por MCP stdio y estrés multiproceso.
- **P2, permisos de archivos (931921a):** reemplazos atómicos conservan bits seguros `mode & 0o777`, eliminan setuid/setgid/sticky, y archivos nuevos quedan `0600`. Recibos de permisos previos y posteriores en SQLite v6, con migración conservadora desde v5.
- **P2, heartbeat (44d9a44):** el CLI deja la duración omitida como `undefined`; el controlador aplica el mínimo entre 300 segundos y el presupuesto de la misión. Test CLI y MCP con un límite de 60 segundos.
- **P2, heartbeat de lease prolongado (0fbe62a):** renovar con duración omitida o menor no recorta una reserva vigente; se conserva el plazo más largo sin superar el deadline de misión. Tests para 600 s, extensiones explícitas, deadline y presupuestos de 60 s.
- **P2, cancelación de RDD (2603dbf):** al cancelar una misión se invalidan los paquetes RDD en RUNNING y sus tokens, pero se conserva la evidencia de lentes finalizados. Los archivos de misión cancelada pueden archivarse sin exigir completar trabajo abandonado; tests con SQLite y rechazo de tokens obsoletos.
- **P2, RDD (2b91918):** una revisión invalidada puede reabrirse con el mismo SHA de feature solo si cambió la base, la rama destino o el árbol congelado. La reapertura consume una ronda y archiva la evidencia anterior; no reemplaza revisiones activas.

### Puertas pendientes

Sin firma CI auténtica, aislamiento operativo del host, E2E de Codex ni aprobación independiente de GitHub. `releaseAuthorized` permanece en `false`.

## [0.3.0] - No publicado

Versión candidata en PR #1. Sin tag, release ni despliegue.

### Añadido

- \`zana_apply_write\`: frontera de efectos locales con permiso firmado Ed25519, lease, rutas y comprobación de preimagen; 24 herramientas MCP.
- Intenciones durables, recibos de SHA previos y posteriores y estado \`OUTCOME_UNKNOWN\` ante caídas antes de confirmar el recibo. Esquema SQLite v5.
- Anclaje Linux por descriptores y rechazo de rutas con symlinks, hardlinks o destinos irregulares.
- Emisor opcional de atestaciones CI Ed25519 y job de GitHub Actions de ámbito restringido; depende del secreto y llave pública provistos por Zana.
- Pruebas adversariales de filesystem, permisos, firmas, recuperaciones, CLI y control de capacidades.
- Guías de conexión a Codex CLI y ejecución humana del E2E.

### Modificado

- Parser CLI exportable y probado, manteniendo los comandos existentes.
- Umbrales globales de cobertura: 92 % líneas, 85 % ramas y 90 % funciones, sin ningún archivo de \`src/\` por debajo de 80 % de ramas.
- README consolidado y documentación de seguridad, almacenamiento, gobernanza y roadmap sincronizada.

### Pendiente antes de liberar

- Llaves reales de operador y CI, environment protegido y atestación CI emitida por GitHub.
- Verificación de aislamiento del sistema operativo y E2E Codex por Zana.
- Revisión independiente, aprobación de PR sobre SHA exacto y decisión humana de merge.
