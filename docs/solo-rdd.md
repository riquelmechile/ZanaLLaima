# RDD verificable con una sola cuenta GPT

**Alcance:** Fase 2 del roadmap. El controlador local valida Git, prepara cuatro revisiones y controla el gate de entrega. **No inicia modelos, no crea subagentes, no confirma la configuración efectiva de GPT y no mergea ni despliega.** La integración real del anfitrión y la fuente de atestaciones CI corresponde a una fase posterior.

## Candidato Git confiable: observación sin confianza en el almacén de objetos

**Invariante de seguridad:** la identidad del candidato se obtiene de un único objeto commit y solo se acepta después de realizar su **re-hash en Node**. No se confía en ningún árbol, blob, índice o configuración del candidato como prueba de que el contenido es seguro.

1. **Lectura única del commit.** Se leen `.git/HEAD`, la referencia de la rama y las configuraciones locales como texto con un parser conservador. Antes de iniciar Git se rechazan partial clone, fetch remoto ejecutable, extensiones desconocidas, includes e instrucciones externas. Una sola llamada aislada a `git cat-file commit <SHA>` devuelve los bytes del commit. Node calcula SHA-1 de `commit <longitud>\\0<bytes>` y exige el SHA exacto del HEAD; el campo `tree` sale únicamente de ese commit validado. En submódulos se revalida el HEAD contra el gitlink del padre.
2. **Árbol calculado desde el disco.** Node recorre con `lstat`, abre archivos sin seguir symlinks, calcula SHA-1 de `blob <longitud>\\0<bytes>`, serializa las entradas Git `100644`, `100755` (bit `mode & 0o100`), `120000` (destino del symlink) y `160000` (HEAD validado del submódulo), ordena con las reglas de árboles Git y calcula cada tree hash desde el disco. Nunca usa bytes de los árboles o blobs almacenados por el candidato. El índice se decodifica en Node únicamente como **guard** de cambios staged, conflictos, flags ocultos y sparse checkout, no como fuente de contenido confiable.
3. **Ignorados aislados.** Para evaluar patrones se crea un gitdir privado y vacío con shadow independiente; contiene únicamente `.gitignore` rastreados, cuyo contenido se lee una vez y se valida contra su blob del índice antes de publicarlo en el shadow. El único comando adicional de Git es `git check-ignore --no-index --stdin -z` contra ese gitdir privado, con `core.excludesFile=/dev/null`; ningún proceso consulta la configuración local del candidato. Las rutas con prefijo `:` se envían como `./ruta` para evitar magia de pathspec. Los directorios se materializan en el shadow para interpretar negaciones y se consultan sin `/` final. No se desciende en carpetas realmente ignoradas, incluso si contienen miles de archivos. Si el commit no rastrea ningún `.gitignore`, se evita crear directorios shadow y lanzar check-ignore innecesariamente. La matriz de 66 escenarios distintos compara el resultado contra `git status --porcelain=v1 -uall --ignore-submodules=none`; no se usa ese comando en producción. Se admite la excepción Python de un `.gitignore` no rastreado con único patrón efectivo `*` exclusivamente en directorios sin entradas rastreadas y sin repositorio Git anidado. La gramática aceptada es exacta: un BOM opcional solo en el primer byte; líneas LF con un único CR final opcional; únicamente líneas vacías, comentarios con `#` en la columna cero y exactamente una línea `*` seguida opcionalmente de espacios ASCII U+0020. Tabs, espacios iniciales, NBSP, blancos Unicode, CR/BOM repetidos y negaciones no conceden la excepción. Un directorio no rastreado con cualquier entrada `.git` se considera extra, aunque esté corrupta; los directorios totalmente ignorados por reglas rastreadas permanecen ignorados.
4. **Decisión.** `clean:true` si y solo si el hash de árbol recalculado coincide con el `tree` del commit verificado y el guard del índice no detecta discrepancias. En caso contrario `clean:false` incluye la primera ruta y categoría `extra`, `missing`, `content`, `mode`, `staged` o `submodule`. Se rechazan explícitamente configuraciones inseguras y atributos de normalización que cambiarían los bytes. **`core.fileMode` y `core.autocrlf` del candidato se ignoran** como controles de seguridad; el modo ejecutable se compara físicamente. Los clones `shallow` funcionan, pues la historia antigua no participa en esta prueba.

**Configuración y atributos:** se rechazan continuaciones de línea con barra invertida final no escapada, `remote.*.promisor`, `remote.*.uploadpack`, protocolos o URL hostiles, `core.worktree` arbitrario, y reglas peligrosas en `.git/info/attributes` y `core.attributesFile`. Solo se permite el `core.worktree` canónico que Git crea para el submódulo real previamente verificado.

**Entorno aislado de cada subprocess Git:** `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=` (vacío), `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_ATTR_NOSYSTEM=1`. Todos los parámetros de configuración inyectados con `-c`: `core.fsmonitor=false`, `core.untrackedCache=false`, `core.hooksPath=/dev/null`, `core.sshCommand=false`, `protocol.allow=never`, `core.excludesFile=/dev/null`, `diff.external=false`, `core.pager=cat`. Además se aplica `--no-replace-objects`. El commit se verifica en Node; no se ejecutan filtros, hooks ni otros comandos del candidato.

El repositorio se define mediante `ZANA_REVIEW_REPO`; la base de comparación `ZANA_REVIEW_TARGET_REF` (predeterminado `refs/heads/main`). El modelo congela `candidateSha`, `treeSha`, `branchRef`, `targetRef`, `baseSha`, `repoRoot`, `clean` y `observedAt`. Las operaciones de revisión vuelven a observar el disco. Una diferencia o un cambio de SHA invalida durablemente los paquetes y resultados de la revisión. Esta observación no concede permisos sobre el sistema operativo ni sustituye una revisión 4R externa.

## Cuatro lentes

| Lente | Aspectos que revisa |
| --- | --- |
| Risk | permisos, límites de confianza, seguridad, filtraciones |
| Reliability | invariantes, transiciones, errores y pruebas |
| Resilience | fallos, reinicios, idempotencia y recuperación |
| Readability | claridad, diseño, contratos y mantenimiento |

Solo se permite abrir la revisión después de completar con éxito todas las unidades de la misión. Cada paquete lleva ID de revisión, SHA del candidato, SHA de árbol, número de ronda y token único. El resultado requiere resumen, evidencia real y hallazgos, y rechaza un `PASS` con BLOCKER, CRITICAL o HIGH.

Hay un máximo de **cinco rondas verificadas** por misión. Las rondas se almacenan en SQLite (`review_count`, esquema v3); la quinta no permite comenzar una sexta. Si se agotan, intervenir manualmente en vez de generar un bucle de correcciones interminable.

## Una cuenta, dos modos

**SOLO_SEQUENTIAL.** Un único contexto realiza una revisión a la vez. Su resultado es `SELF_CHECK_COMPLETE_UNVERIFIED`; no es independiente.

**NATIVE_PLANNED.** Si el anfitrión informa subagentes nativos, el controlador prepara como máximo `min(maxConcurrent, 4)` paquetes simultáneos. La capacidad reportada no demuestra que nacieron contextos. Cada paquete nativo necesita un ID de contexto diferente, pero ese identificador es todavía autodeclarado. Su resultado puede ser `NATIVE_4R_REPORTED_UNVERIFIED`, nunca una certificación de independencia.

Si la capacidad nativa desaparece o se reduce, el controlador limita la tanda o continúa secuencialmente. Si se mezclan revisiones nativas y autocomprobaciones, el estado final es `MIXED_CONTEXTS_SELF_CHECK_UNVERIFIED`. Los paquetes ya iniciados deben completarse antes de cambiar el modo. La prohibición de compartir hallazgos entre lentes es un contrato de ejecución; el controlador no puede probar el aislamiento del anfitrión hasta la integración real.

## Comandos de revisión

Con todas las tareas de la misión completas y el worktree limpio:

```sh
node src/cli.mjs review-open "$(git rev-parse HEAD)"
node src/cli.mjs review-next [host.json]
node src/cli.mjs review-start [host.json]
node src/cli.mjs review-submit <lens-id> <token> <candidate-sha> resultado.json
node src/cli.mjs review-status
node src/cli.mjs review-check
```

`review-open` contrasta el SHA suministrado con el HEAD real. `review-check` no confía en un SHA enviado por un cliente: consulta Git directamente. Los comandos `review-next` y `review-start` pueden recibir informes de capacidad actualizados; si no se entregan, utilizan la configuración congelada para la revisión.

Los comandos MCP `zana_review_*` ofrecen el mismo ciclo de control. No dan acceso a las claves privadas del operador ni ejecutan cambios automáticamente.

## Gate de entrega separado

El archivo `src/delivery.mjs` distingue **RDD terminado** de **decisión manual sobre entrega**. Requiere todos los lentes en PASS, ausencia de hallazgos bloqueantes y Git inalterado.

Además exige dos atestaciones Ed25519 independientes, que deben generarse fuera del contexto del modelo:

1. Una atestación `CI_RESULT` firmada por un verificador CI confiable, vinculada a SHA, árbol, base, rama, destino, runId y resultado `success`.
2. Una aprobación `APPROVE_REVIEW` firmada por el operador, vinculada al mismo commit, misión, revisión y runId del CI, con decisión `ALLOW_MANUAL_RELEASE`.

Las claves públicas se configuran con `ZANA_CI_PUBLIC_KEY_PATH` y `ZANA_OPERATOR_PUBLIC_KEY_PATH`; deben ser distintas. Las claves privadas se mantienen fuera del repositorio y fuera del alcance del modelo. Las atestaciones poseen fecha de emisión y expiración, y las firmas inválidas, fechas caducadas o referencias inconsistentes bloquean la entrega.

```sh
node src/cli.mjs delivery-check /ruta/atestacion-ci.json /ruta/aprobacion-operador.json
```

Sin firmas, el gate devuelve `BLOCKED`. Con ambas válidas, puede devolver `READY_FOR_MANUAL_RELEASE`, pero sigue informando:

- `mergeAuthorized: false`
- `deploymentAuthorized: false`
- `independentReviewVerified: false`

**No se conecta actualmente a GitHub Actions para obtener y firmar resultados CI auténticos.** Las pruebas utilizan claves temporales y atestaciones simuladas para validar el algoritmo. La fuente real del verificador y su autenticación se integrarán más adelante.

## Validaciones adversariales

La suite cubre cambios de SHA y árbol, worktree sucio, movimiento de rama base, HEAD desacoplado, capacidad 1/2/4, pérdida de subagentes, contexts repetidos, tokens obsoletos, hallazgos HIGH/BLOCKER, límite de cinco correcciones, CI falsificado, firmantes no independientes, aprobaciones caducadas y falta de atestaciones.

No interpretar una suite verde como una revisión RDD independiente ni como autorización de entrega. El PR permanece en borrador hasta que se disponga de integración y verificación real.

## RDD remoto: ticket, conversación nueva y cuenta revisora

En el modo remoto la revisión la hace el **mismo GPT en una conversación nueva** de la app de ChatGPT, con la skill `zana-4r`. No se exige otro LLM: la independencia que ZanaLLaima puede comprobar viene de la sesión distinta, y la publicación en GitHub la firma la cuenta revisora configurada en `ZANA_REVIEWER_LOGIN` (`ZANA_REVIEWER_TOKEN`), distinta del token autor (`ZANA_DOWNSTREAM_GITHUB_TOKEN`).

1. **`zana_review_request(missionId)`**, desde la sesión autora: exige un PR abierto desde `zana/<missionId>` hacia la base de la misión y checks verdes sobre su head. Exige el orden de la skill: con una unidad de código `RUNNING` responde `UNIT_STILL_RUNNING`; primero `zana_complete_unit` (con check verde sobre el head) y después el ticket. Se rechaza con `CHANGES_REQUESTED_SAME_SHA` si algún ticket sobre ese mismo SHA pidió cambios (veredicto `REQUEST_CHANGES` o un lente con BLOCKER/CRITICAL que no sea `PREEXISTING`), **en cualquier estado**: vivo, `FINALIZED`, `STALE_SHA`, `EXPIRED` o `ABANDONED` por el TTL del claim. Esperar un TTL no compra otra review del mismo SHA: hay que cambiar el código, y solo `remote-ticket-abandon` del operador libera un ticket no finalizado. Si la review pide cambios, `zana_correction_start` agrega la unidad de corrección (revalida el último ticket dentro de la transacción de la misión). Cada ticket consume una ronda de `maxReviewRounds` (`REVIEW_ROUNDS_EXHAUSTED`). Un ticket nuevo deja `STALE_SHA` (otro SHA) o `ABANDONED` (mismo SHA) a los tickets vivos anteriores de la misión. Crea un ticket `ZR-XXXX-XXXX-XXXX-XXXX` de un solo uso (en SQLite solo su SHA-256), con vencimiento (`ZANA_TICKET_TTL_MINUTES`, 120 por defecto), atado a repo, PR, SHA y sesión autora. Antes de crearlo mide el tamaño: si el diff `base...sha` pesa más de `ZANA_REVIEW_MAX_DIFF_BYTES` responde `DIFF_TOO_LARGE` (sin excepción: se divide en misiones secuenciales); si las adiciones + eliminaciones del PR sin lockfiles ni `.zanallaima.json` superan el presupuesto (`ZANA_PR_LINE_BUDGET` o la extensión de la misión) responde `OVER_LINE_BUDGET`. Solo con el sí del usuario la sesión autora llama `zana_budget_extend(missionId, lines, reason)`, una tool de escritura auditada como `write`. Si GitHub no entrega el diff (406/422 por más de 300 archivos) también responde `DIFF_TOO_LARGE`. Si la lista de archivos no coincide con `changed_files` del PR la medida queda `truncated` y responde `OVER_LINE_BUDGET`. Si el head se movió mientras se medía responde `HEAD_MOVED` antes de cualquier cifra del presupuesto. El ticket guarda su `lineBudget` y el claim devuelve esa misma medida, fija al SHA del ticket; `zana_delivery_status` la mide en vivo, solo informativa y dentro de su plazo (`partial`). El ticket y el claim traen `diffBytes`. Devuelve el texto que el usuario pega en una conversación nueva.
2. **`zana_review_claim(ticket)`**: se rechaza con `AUTHOR_SESSION`, `SESSION_WROTE` (la sesión mutó la misión con éxito o una escritura suya llegó al downstream), `SESSION_PREDATES_TICKET` (sesión creada antes que el ticket), `SAME_CLIENT` (solo con `ZANA_DISTINCT_REVIEWER_CLIENT=true`: el cliente OAuth de la revisora no puede ser el que pidió el ticket ni ninguno con actividad en la misión), `TICKET_ALREADY_CLAIMED` o `TICKET_EXPIRED`. Devuelve el manifiesto del diff de `base...SHA`, paginado por archivo (`zana_review_diff`); el servidor registra qué páginas leyó la sesión revisora. Un ticket reclamado que no se finaliza en `ZANA_TICKET_CLAIM_TTL_MINUTES` (240 por defecto) pasa a `ABANDONED`; el merge igual exige una aprobación exacta sobre el head, y sus lentes BLOCKER/CRITICAL que no sean `PREEXISTING` siguen bloqueando un ticket nuevo sobre el mismo SHA. El operador también puede abandonarlo (`remote-ticket-abandon`), lo que sí libera ese SHA. El diff se lee de la API de GitHub con un tope de 2 MB por respuesta: un diff mayor no se puede revisar (`diffManifestError`) y hay que dividir el cambio. La sesión que reclama queda en **solo lectura** sobre la misión: el downstream y las tools de misión le responden `REVIEWER_READ_ONLY`.
3. **`zana_review_lens_submit`**: un envío por lente (`risk`, `readability`, `reliability`, `resilience`); cada hallazgo exige `severity` (`BLOCKER`, `CRITICAL`, `WARNING`, `SUGGESTION`), `location` `archivo:línea`, `evidence` y `origin` (`INVALID_FINDING` si falta o no es válido): `INTRODUCED` (el diff agrega o cambia la línea), `ACTIVATED` (el diff hace alcanzable un defecto previo), `WORSENED` (lo agrava), `PREEXISTING` (ya estaba igual en la base) o `UNKNOWN` (duda). `proof` es opcional, de hasta 2000 caracteres, y obligatorio para `PREEXISTING`: debe citar al menos un `archivo:línea` de la base (el claim trae `base` y `baseSha`, el merge-base, para leerla con `get_file_contents` y `ref`). La ruta de la cita debe tener `/` o `.` ("16:30" no vale). El servidor rebaja a `UNKNOWN` cualquier `PREEXISTING` ubicado en un archivo que el PR modifica: la `location` se compara con la lista de archivos del PR (`pulls/files` en el SHA del ticket, guardada en el ticket junto al `lineBudget`; un rename cuenta con `filename` y `previous_filename`), canonizada (`\` a `/`, sin `./`, `a/`, `b/`, `/` inicial ni `//`, sin mayúsculas) y por segmentos (`s.mjs` calza con `src/s.mjs`, y `o/r/src/s.mjs` también). Una location que no es ruta, o sin la lista (falta o truncada), también queda `UNKNOWN`; la respuesta lo informa en `originDowngraded`. `PREEXISTING` solo sirve para defectos en archivos que el PR no toca. **Bloquea** un hallazgo BLOCKER o CRITICAL que no sea `PREEXISTING`; los lentes guardados antes de `origin` cuentan como `UNKNOWN` y siguen bloqueando. El mismo criterio vale para `CHANGES_REQUESTED_SAME_SHA`, los tickets abiertos que bloquean el merge y el veredicto de finalize. El lente se guarda en `review_receipts` con su hash, que incluye `origin` y `proof`.
4. **`zana_review_finalize`**: exige los cuatro lentes y **todas las páginas del diff leídas** (`DIFF_NOT_FULLY_READ`); relee el head del PR en GitHub y, si cambió, deja el ticket `STALE_SHA` sin publicar nada; exige checks verdes sobre ese SHA; publica la review con el token revisor, `commit_id` = SHA, `APPROVE` sin BLOCKER ni CRITICAL que bloqueen o `REQUEST_CHANGES` si los hay, con la tabla por lente (los conteos excluyen lo preexistente, que va en su columna), el origen de cada hallazgo, la sección "Pendientes preexistentes (no bloquean)" con su prueba, el ticket, el hash de cada lente y la declaración de ejecución (`PARALLEL_SUBAGENTS` o `SEQUENTIAL_SAME_CONVERSATION`); crea el status `zana/4r` (success o failure) con el mismo token. El cuerpo lleva un marcador del ticket: si la respuesta de GitHub se pierde, el siguiente finalize adopta esa review en vez de publicar otra. El reemplazo de tickets (`zana_review_request`), la publicación y `zana_merge` se serializan por misión. Los pasos a `FINALIZING` y a `FINALIZED` son condicionales, y antes de publicar la review y antes de `zana/4r` se revalida en la DB que el ticket siga `FINALIZING` y sea el vigente. Quedan dos escrituras no condicionales: el paso a `STALE_SHA` cuando el head cambió (no publica nada) y el registro de `github_review_id` (es un hecho: la review ya está en GitHub). Si el ticket se reemplaza o vence después de la última revalidación, la review o incluso `zana/4r` pueden quedar publicados, pero no cuentan: el ticket no revive, la fila de auditoría `INCONSISTENT` registra lo publicado, y el merge solo acepta el ticket vigente (paso 5).
5. **`zana_delivery_status`** (solo lectura, adaptado de Panter-ai `github-delivery.ts`) informa `APPROVED_EXACT_SHA`, `STALE_SHA`, `CHANGES_REQUESTED`, `DISMISSED`, `REVIEWER_IS_AUTHOR` (la revisora es autora del PR o de un commit), `MISSING` o `UNAVAILABLE`, el CI, `zana/4r` y si el PR es mergeable. La autoridad es el **ticket vigente** de la misión (el más reciente): debe estar `FINALIZED` con `APPROVE` sobre el head, y su review debe ser la última review decisiva de la revisora en GitHub. Un `APPROVE` de un ticket reemplazado sobre el mismo SHA no habilita el merge (`currentTicket` en la respuesta).
6. **`zana_merge`** (con el lock de la misión, y releyendo en la DB el ticket vigente justo antes de llamar al merge: si cambió durante las lecturas a GitHub responde `NOT_READY` sin mergear, también entre procesos) mergea solo con todo verde sobre el mismo head: aprobación exacta de la revisora, CI verde, `zana/4r` success, PR mergeable y ningún ticket abierto con BLOCKER o CRITICAL que no sea `PREEXISTING`. Usa la API de merge con `sha` = head verificado (equivale a `--match-head-commit`); si el head cambió, GitHub lo rechaza y ZanaLLaima responde `STALE_SHA` sin reintentar. Lo puede pedir la sesión que creó la misión, una sesión que tuvo una de sus unidades (`zana_start_batch` o `zana_session_rebind`) o el operador (`node src/cli.mjs remote-merge <missionId>`). Cada intento queda auditado con el `headSha`; si la respuesta del merge se pierde, se relee el PR y se informa `MERGED` si quedó mergeado; `ZANA_MERGE_ENABLED=false` lo apaga. La protección de rama de `main` sigue siendo la segunda llave.

**Ventana residual entre procesos.** El lock por misión serializa `zana_review_request`, `zana_review_finalize` y `zana_merge` dentro de **un** proceso. Si además corre el CLI del operador (`remote-merge`) contra la misma base, queda una ventana entre `revalidate()` y la llamada de merge en la que otro proceso podría crear un ticket. Está acotada: un ticket sobre otro SHA exige que cambie el head, y eso lo bloquea `sha = head` en el merge; un ticket nuevo sobre el mismo SHA no alcanza a tener lentes BLOCKER dentro de esa ventana. El cerco durable en SQLite (issue #3, punto 1) queda pendiente.

### Qué prueba y qué no

**Sí prueba:**
- que la sesión que reclamó el ticket no es la sesión autora;
- que esa sesión no usó ninguna tool que muta la misión ni escribió por el downstream antes de reclamar;
- que se creó después del ticket y que, una vez revisora, no puede escribir en la misión;
- que la review publicada corresponde a ese SHA exacto, con CI verde sobre él y el head del PR sin cambios al finalizar;
- que llegaron los cuatro lentes, cada hallazgo con ubicación y evidencia, y que se publicaron con la cuenta revisora.

**Con `ZANA_DISTINCT_REVIEWER_CLIENT=true` también prueba** que la revisora usó **otro cliente OAuth registrado** que el que pidió el ticket y que todos los que actuaron en la misión (el ticket guarda el `clientId` del autor y `remote_activity` el de cada acción; el claim exige uno distinto: `SAME_CLIENT`). Que sea otra cuenta de ChatGPT depende de que el operador solo dé de alta cuentas distintas: ZanaLLaima ve clientes OAuth, no cuentas. Por defecto está apagado porque Zana decidió que puede ser el mismo GPT en una conversación nueva.

**No prueba:**
- qué modelo usó el anfitrión ni su esfuerzo;
- que los subagentes existieran ni que tuvieran de verdad contexto fresco: la declaración `execution` es palabra del anfitrión;
- que un hallazgo `PREEXISTING` de verdad estuviera igual en la base: el servidor solo exige que la `location` caiga en un archivo que el PR no toca y que `proof` cite un `archivo:línea`; la prueba sigue siendo palabra de la revisora;
- con el flag apagado, que dos sesiones distintas correspondan a dos conversaciones distintas. Ambas usan la misma cuenta OAuth, así que ZanaLLaima solo distingue el `Mcp-Session-Id` (un id efímero: es una limitación aceptada del diseño). Si ChatGPT reutiliza una sesión entre conversaciones, o abre una sesión nueva dentro de la conversación autora (por ejemplo tras un reinicio del servidor, porque las sesiones viven en memoria), la regla no lo detecta: una sesión nueva de la conversación autora, sin escrituras y posterior al ticket, podría reclamarlo.

La separación de sesiones depende de que ChatGPT abra una sesión MCP nueva por conversación. **Eso se verifica en el E2E real** (`docs/host-e2e-remote.md`, paso de `zana_session_status` en ambas conversaciones) y el resultado observado se escribe en `examples/host-e2e-remote.json`. Hasta entonces queda **sin observar**.
