# Registro de cambios

## [0.5.2] - No publicado

- **R11-C1 (restore):** el restore offline sin `--force-data-loss` se rechaza con `CONSUMED_BUDGET` si la DB viva tiene trabajo RUNNING o si su ledger de presupuesto consumido registra más intentos o generaciones de lease que el backup. Test negativo previo `d4f8de8` (hilo Codex `4485193503`). Con `--force-data-loss` se conserva `max(viva, backup)` por unidad, y en `storage-adopt-quarantine` el máximo entre la cuarentena elegida y sus hermanas legibles. La `revision` se fusiona en todo restore y queda por sobre cada fuente legible.
- **R11-C1b (restore):** ledger `consumed_budget` por misión y unidad, que incluye misiones archivadas y se fusiona en cada restore y adopt, para que pasar por otra misión (A→B→A) no reinicie el presupuesto. Test negativo previo `88de027` (lente R2 sobre `cc8f61e`). También cubre una misión archivada o reemplazada (test previo `bcea605`).
- **R11-C1c (adopt):** una cuarentena o `.aborted.*` hermana ilegible rechaza el adopt con `UNREADABLE_SOURCE` salvo `--force-data-loss`; la fuente omitida queda en `skippedSources` del evento y del resultado. El restore ciego fusiona el ledger de las copias legibles. La CLI imprime el código de error (`[CODE] mensaje`).
- **R11-C1d/e (ledger):** claves validadas (UUID de misión, id de unidad) en mapas sin prototipo y contadores enteros ≥ 0; un ledger corrupto da `INVALID_LEDGER` y, con `--force-data-loss`, se reconstruye desde las unidades (`ledgerRebuilt`). El restore informa `blind` y `skippedSources`. Una unidad `OUTCOME_UNKNOWN` conserva su generación. Una fusión que deja el total sobre el límite ya no impide cancelar ni archivar. Tests negativos previos `9969e84` y `a7a251e`. Modelo de amenaza documentado en `docs/sqlite-storage.md`.
- **R11 final:** el ledger y el archivo del backup se validan en todo restore, ciego incluido; el adopt con `--force-data-loss` mueve las filas archivadas corruptas a `mission_archive_corrupt`; las claves aceptan ids legacy no UUID; una hermana con ledger inválido se etiqueta `INVALID_LEDGER`; la re-ejecución del adopt tras un crash devuelve `skippedSources` y `ledgerRebuilt`. Tests negativos previos `f561a9c` y cobertura de ramas `af8cd06`. El restore ciego también aplica el ledger propio del backup a sus unidades (P1 de la revisión con criterio Codex de GPT-A, test negativo previo `5876100`).
- Congelados por el cambio a MCP remoto: endurecimiento de `git-evidence`, `zana_apply_write`, grants de escritura y aislamiento de OS. Ver `ROADMAP.md`.

## [0.5.1] - No publicado

Correcciones R10 sobre la revisión 4R de `7b6f3b1`: gramática exacta de autoignore Python, fusión monotónica de revocaciones y nonces durante adopción de cuarentena con cerco ciego, y repositorios `.git` anidados fail-closed. Hardening de config/atributos Git, epoch durable, crash de flock y benchmark con `.gitignore` rastreado. Candidato pendiente de revisión independiente, sin tag, merge ni deploy.

## [0.5.0] - No publicado

Rediseños de verificación Git y recuperación SQLite, y cierre de la ronda 9. **No es un release**; nueva 4R independiente requerida.

- El verificador deja de confiar en árboles/blobs del almacén de objetos del candidato. Re-hashea en Node el único commit leído en entorno aislado y reconstruye el árbol exclusivamente desde el worktree. **Sustituye explícitamente el método de verificación completa de objetos de R7**; elimina sus llamadas para evitar ejecución involuntaria y carreras. El índice únicamente impide aceptar cambios staged.
- El restore deja de buscar la **cuarentena más reciente**. El diario durable identifica un UUID y los renames exactos de principal/WAL/SHM; los checkpoints exclusivos y el replay/abort preservan revocaciones, nonces y eventos. La primera publicación del diario ahora usa temporal + fsync + link exclusivo y recupera marcadores incompletos sin movimientos.
- R9 C1: prefijo `./` en check-ignore para rutas con dos puntos y otros pathspecs. R9 C2: materialización de directorios en shadow antes de resolver negaciones. R9 C3: uso de bytes de `.gitignore` rastreados comprobados contra el índice antes de copiar al shadow. R9 C4: autoignore Python `*` sin archivos rastreados en el directorio. R9 C5: publicación inicial atómica del diario. R9 C6: documentación de frontera de confianza y recuperación alineada al código y comprobada en todos los Markdown.
- **WARNING R9 restantes:** bloqueo offline interproceso `flock` compartido por restore, abort y cleanup (`1282824`, test negativo `90acfd5`); adopción extraordinaria por UUID exacto y `--confirm` cuando la DB viva se perdió y no existe diario (`6b8e37e`, test negativo `88cf88d`). Se registra `QUARANTINE_ADOPTED` antes de publicar la base y se conservan los nonces y las revocaciones de esa cuarentena. El resto de validaciones incluye epoch futuro limitado a `now`, parser de Git config legacy y rechazo de remotos peligrosos, Git anidados y `text=auto` LF seguro.
- **Rendimiento y regresión:** omitir el shadow de ignorados cuando no hay `.gitignore` rastreado (`007ab84`); benchmark 5000 archivos en 3400 directorios con umbral fijo de 1 segundo. La matriz `tests/r8-git-matrix.test.mjs` contiene **66 escenarios únicos** con 0 falsos positivos y 0 falsos negativos contra porcelain `-uall --ignore-submodules=none`. Los hooks de crash verifican journal-ready, cuarentena y cada rename alcanzable; no equivalen a instrumentar cada syscall de disco.
- Mantener los controles de firma CI en `workflow_run` desde `main`, el reviewer humano y `prevent_self_review`; ninguna prueba sustituye una aprobación 4R independiente.
- Los tests negativos por CRITICAL se registraron en commits anteriores a los fixes. No se reduce cobertura, umbrales ni gates. No hay merge, tag, deploy ni aprobación.


## [0.4.2] - No publicado

Cierre técnico de hallazgos 4R sobre `79d4494`, sujeto a nueva revisión independiente y sin autorización de release.

- **CRITICAL 1, integridad Git (`3159629`):** verificación completa de objetos alcanzables desde HEAD con `git fsck --full --strict`, sin `--connectivity-only`; submódulos incluidos. Bloqueo de grafts y shallow. Negativos `tests/git-object-integrity-r7.test.mjs` publicados en `b2d69dd`, ampliados con commit, árbol raíz y pack.
- **CRITICAL 2, operador (`a6c7593`):** checklist CI `workflow_run` actualizado: firma exclusivamente desde `main`, reviewer requerido y `ci-attestation.yml`. Pruebas negativas documentales `0584e6b`.
- **CRITICAL 3, restore (`877ba6c`, `d56f5ff`):** cuarentena más reciente como DB viva después de SIGKILL, fusión monotónica de revocaciones y nonces, restore ciego exige `forceDataLoss` y revoca todo, epoch de firmas; nuevo `storage-restore-abort` exclusivamente CLI. Negativos `247bc59`.
- **CRITICAL 4, temporales (`cf9f8e1`):** inspección y limpieza best-effort que informa errores sin bloquear `storage-status`, `recover-expired` ni `RECONCILE_WRITE`. Negativos `71cdaaa`.
- **WARNING Git (`ed6fe16`, `d762dc4`, `a9cfd92`, `72cc0ac`):** exclusiones limitadas a `.gitignore` comprometidos, comparación de bit propietario con `core.fileMode`, rechazo explícito de atributos de normalización y hashing en lote `--stdin-paths`. Benchmark 5.000 archivos en menos de un segundo, sin bajar umbrales.
- **WARNING fronteras y recuperación (`27a5b3d`, `f239928`, `975bdfa`):** nombres reservados tras NFKC/casefold, inventario de restores huérfanos/sidecars y `reconcile-view` local que no expone tokens vía MCP.
- **WARNING firma CI (`799714d`, `164d19e`):** Ed25519 generado a temporal en directorio privado y movimiento sin clobber; `prevent_self_review=true` y eliminación de helper muerto.
- **WARNING restore (`2879814`, `7fec1af`):** separación de `inspectLive`, `mergeSecurityFacts`, `swapAtomically`; errores guard con código tipado. Política de W6 original sobre locks I/O se mantiene explícitamente documentada.
- Sin merge, aprobación, tag, release ni despliegue; gates de firma CI real, aislamiento del host y revisión 4R independiente todavía pendientes.


## [0.4.1] - No publicado

Correcciones P1 de la revisión Codex sobre `dc2c443`; la revisión 4R independiente sigue `CHANGES_REQUESTED` y requiere nueva evaluación del SHA.

- **P1-a, submódulos:** `observeGit()` dejó de usar `git status` y dejó de ejecutar filtros configurables antes de validar cada submódulo. Se comparan entradas del índice, árbol de `HEAD`, modos y contenido sin filtros de forma recursiva. Pruebas negativas con filtros maliciosos a uno y dos niveles.
- **P1-b, config efectiva:** `git hash-object --no-filters` impide usar `config.worktree`, `include`, `includeIf` y `.gitattributes` para ejecutar filtros u ocultar contenido. El índice conserva el rechazo de flags ocultos, y todas las llamadas mantienen desactivados fsmonitor, hooks, caché y protocolos.
- **P1-c, restauración:** antes del intercambio atómico, `restoreBackup()` conserva los nonces consumidos y todas las revocaciones de la base viva; ni `forceDataLoss` puede deshacerlas. Una base viva ilegible exige `forceDataLoss` y revoca todos los grants del respaldo. Cuatro negativos confirmados rojos antes del fix en CI #41956409060.
- **P1 tercera iteración, reemplazo de objetos Git:** deshabilitar `git replace` sobre todas las llamadas, también submódulos, con `--no-replace-objects` y `GIT_NO_REPLACE_OBJECTS=1`; pruebas negativas con árbol reemplazado en raíz y submódulo (`280821c`, `tests/git-evidence-replace-r6.test.mjs`).
- **P2 tercera iteración, gitlink tipo symlink:** validar con `lstat` el propio directorio del gitlink **antes** de resolver su ruta; un enlace a una copia interna del submódulo ya no valida (`7ee211f`, `tests/git-evidence-gitlink-symlink-r6.test.mjs`).
- **P2 nuevo de Codex:** impedir que symlinks en directorios intermedios de archivos rastreados, aunque apunten dentro del repositorio, permitan observar limpio un árbol con rutas movidas. Inspección componente por componente con `lstat`; regresión negativa a uno y dos niveles en `tests/git-evidence-symlink-parent-r6.test.mjs`. Corrección `d14711e`.
- **Pruebas adicionales:** detección de symlinks, tipos, modos, gitlinks, paths y cambios de evidencia, sin rebajar umbrales de cobertura.
- Candidato sin release, merge, tag ni deploy. Atestación real y nueva revisión independiente pendientes.


## [0.4.0] - No publicado

Revisión independiente 4R del PR #1; candidato sin autorización de release.

- **CRITICAL C1:** firma CI separada con `workflow_run` desde el código protegido de `main` (opción B). Nunca se instala ni ejecuta código del PR con `ZANA_CI_SIGNING_KEY`; GitHub API verifica run, matriz, SHA, árbol, base y workflow CI confiable. El environment `ci-attestation` exige configuración humana del reviewer independiente y permite solo `main`.
- **CRITICAL C2:** desactivar Git `core.fsmonitor`, caché no rastreados, hooks y protocolos; rechazo conservador de filtros ejecutables locales. Pruebas negativas de hooks root/submódulo y filtro.
- **Rutas:** política `validateRelativePath`/`inScope` compartida, rechazo `.git`/`.zana` y estado fuera del workspace de efectos.
- **Evidencia y filesystem:** reconciliación con predicado `trim` único, cierre de file descriptors en errores y rechazo de PEM privado como clave pública.
- **SQLite:** rollback condicional preserva error original; prueba `RAISE(ROLLBACK)`.
- **WARNING W6:** efecto y recibo permanecen bajo `BEGIN IMMEDIATE` para preservar fencing de grant; timeout cooperativo de 5 s antes del `rename`, sin garantía de cancelación del kernel.
- **WARNING W7:** nombres temporales persistidos en intención; storage-status enumera huérfanos, recover-expired/reconciliación limpian; regresión SIGKILL antes de rename.
- **WARNING W8:** restores offline sobre temporal con migración a esquema actual; rechazan recibos nuevos o intents inciertos salvo flag `--force-data-loss`; pruebas de rollback.
- **WARNING W9-W10:** versión MCP desde package.json, docs de v6 y recibos corregidas; heartbeat prueba el reloj después del retorno.
- Candidato no liberado. Llave CI placeholder, aislamiento de host y revisión humana del último SHA pendientes. Sin merge, tag ni deploy.

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
