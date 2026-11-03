# RDD verificable con una sola cuenta GPT

**Alcance:** Fase 2 del roadmap. El controlador local valida Git, prepara cuatro revisiones y controla el gate de entrega. **No inicia modelos, no crea subagentes, no confirma la configuración efectiva de GPT y no mergea ni despliega.** La integración real del anfitrión y la fuente de atestaciones CI corresponde a una fase posterior.

## Candidato Git confiable

Antes de iniciar una revisión, el proceso local verifica Git mediante `src/git-evidence.mjs`. El repositorio se obtiene de `ZANA_REVIEW_REPO` (o del directorio de trabajo); el objetivo de comparación de `ZANA_REVIEW_TARGET_REF` (por defecto `refs/heads/main`). No se permite que un argumento MCP defina estas rutas.

El sistema conserva:

- `candidateSha`: objeto commit real de HEAD, comprobado por Git.
- `treeSha`: árbol exacto del commit.
- `branchRef`: rama de trabajo real; no se permite HEAD desacoplado.
- `targetRef` y `baseSha`: destino y su posición en la apertura.
- `repoRoot`: ruta real de la raíz del worktree.
- `clean`: resultado de `git status --porcelain=v1 --untracked-files=all`.
- `observedAt`: momento de lectura local.

Se rechaza abrir revisión si existen modificaciones sin confirmar o archivos no rastreados. Las operaciones de revisar, iniciar, enviar y comprobar vuelven a contrastar Git. Si cambia el commit, el árbol, el destino, la rama o la limpieza del worktree, el ciclo se **invalida durablemente**. No se reutilizan sus paquetes ni sus recibos.

La inspección Git tiene una ventana temporal limitada, pero no es un sandbox de archivos ni puede impedir mutaciones hechas por un ejecutor externo. La verificación final siempre requiere una nueva observación.

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
