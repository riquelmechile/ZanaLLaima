# MCP v2: modos stdio y remoto, y contrato del anfitrión

## Propósito y estado

Esta implementación reemplaza el transporte MCP `stdio` construido manualmente por el **SDK oficial TypeScript v2**, fijado en `@modelcontextprotocol/server@2.4.0`. Usa `@modelcontextprotocol/client@2.4.0` en las pruebas y `zod@4.6.7` para definir y validar los argumentos. El modo **stdio** es local y sin HTTP. El modo **remoto** (Streamable HTTP + OAuth, ver abajo) sirve a la app de ChatGPT. Ninguno llama a proveedores de inferencia.

El SDK soporta la especificación MCP 2026-07-28 y negociación con clientes compatibles con versiones anteriores. En stdio el catálogo tiene **24 herramientas**, incluyendo `zana_capability_status`; en remoto tiene 42 (tabla abajo). La conexión real con ChatGPT la ejecuta el operador (`docs/host-e2e-remote.md`).

Fuentes normativas del SDK:
- https://ts.sdk.modelcontextprotocol.io/v2/
- https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html
- https://ts.sdk.modelcontextprotocol.io/v2/servers/logging-progress-cancellation.html

## Uso local

Instalar dependencias en un entorno controlado:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
node src/mcp.mjs
```

El servidor utiliza exclusivamente la entrada/salida estándar del proceso. **stdout** es el canal de protocolo; los diagnósticos solo van a **stderr**. Un host MCP local puede lanzar `node /ruta/absoluta/ZanaLLaima/src/mcp.mjs`. No configurar un callback HTTP inventado ni un endpoint de suscripción.

Las rutas para revisión Git y almacenamiento deben ser locales y restringidas al entorno de trabajo:
`ZANA_STATE_FILE`, `ZANA_REVIEW_REPO` y `ZANA_REVIEW_TARGET_REF`. Los permisos WRITE requieren la clave pública del operador y las restricciones descritas en `safety-lifecycle.md`. **No entregar la clave privada ni secretos al proceso MCP o a un agente.**

La especificación MCP y la configuración del cliente no conceden permisos de escritura. El controlador sigue exigiendo autorización independiente al reservar, comprobar y completar trabajos; el enforcement en el *ejecutor real* del anfitrión permanece como un bloqueo de integración.

## Contrato de capacidades

`zana_capability_status` devuelve tres niveles **no intercambiables**:

- `requested`: requisitos solicitados (modelo, esfuerzo, límites y ausencia de fallback deliberado). No demuestra selección efectiva.
- `hostReported`: modelo, esfuerzo y capacidad de subagentes tal como los declara el cliente. Su procedencia es `HOST_REPORTED_UNVERIFIED` o `NOT_REPORTED`.
- `verified`: modelo, esfuerzo, ejecuciones y evidencias que realmente se verificaron mediante una fuente independiente y autenticada. Por ahora se mantienen en `null` y `NOT_OBSERVED`: una cadena declarada por el cliente no puede llenarlos.

`decision` expone un **plan** de ejecución limitado a cuatro trabajos independientes. Un informe no puede ampliar permisos, firmar una decisión del operador, certificar un subagente o promover un resultado de RDD a revisión independiente. La futura verificación real debe permanecer en una capa de atestación diferente, no en `hostReport`.

## Operaciones, validación y cancelación

Las herramientas usan esquemas Zod estrictos. Un argumento inválido, una operación rechazada por el motor o un recurso ausente produce una respuesta de herramienta `isError: true`, en vez de convertir un fallo recuperable en error general de JSON-RPC. El SDK gestiona `initialize`, negociación, `notifications/initialized`, solicitudes, `tools/list`, `ping` y `notifications/cancelled`.

El manejador consulta `ctx.mcpReq.signal.aborted` antes de despachar. **La cancelación es cooperativa**, no una reversión de efectos ya confirmados: después de abortar o perder una conexión, el cliente debe leer el estado durable antes de reintentar. Si una escritura queda incierta, mantener `OUTCOME_UNKNOWN` y exigir reconciliación firmada. No asignar `success:true` por el hecho de recibir una respuesta.

## E2E local sin subagentes (ZL-019)

`tests/sdk-mcp.test.mjs` inicia un proceso local real `stdio` mediante el cliente oficial. Verifica negociación, descubrimiento del catálogo, validación de argumentos, tratamiento de errores, frontera de capacidades y una misión **READ** completa. Crea un repositorio Git temporal, revisa su SHA verificado y completa los cuatro lentes secuencialmente. Debe terminar en `SELF_CHECK_COMPLETE_UNVERIFIED`, `independentReviewVerified:false` y `approved:false`. Los resultados de la prueba son pruebas de integración del **controlador**, no revisiones de código independientes realizadas por un modelo.

Desde el 9 nov 2026 hay una prueba con una cuenta ChatGPT real para el camino feliz del modo remoto (`examples/host-e2e-remote.json`). No hay evidencia de modelo/esfuerzo real ni de subagentes nativos lanzados. Estos criterios corresponden a **ZL-018** y siguen abiertos por decisión del operador.

## Modo remoto (ZL-020, esta versión)

`src/http.mjs` escucha solo en loopback IPv4, puerto `ZANA_HTTP_PORT`, con el transporte **Streamable HTTP con sesiones** del SDK (`WebStandardStreamableHTTPServerTransport`, era 2025). Un túnel de Cloudflare lo publica en el hostname de `ZANA_PUBLIC_HOST`, que no tiene valor por defecto (ver `docs/deploy-remote.md`). Cada sesión tiene su `Mcp-Session-Id`, su transporte y su `McpServer`; el id queda **atado a la identidad OAuth** que la abrió (otra identidad recibe 403) y su `createdAt` se guarda en SQLite. ChatGPT abre una sesión MCP nueva en casi cada tool call, así que la **sesión de ZanaLLaima** de cada llamada sale de `_meta["openai/session"]` (id anonimizado de la conversación): `oai-` + hash de la identidad OAuth y ese valor. Sin el campo manda el `Mcp-Session-Id` (`conversationSessionId` en `src/http.mjs`). Una petición con sobre por-request 2026 recibe un error de versión, y el cliente que negocia cae al handshake con sesión (probado con el cliente oficial en modo `auto`).

- **OAuth con registro cerrado** (`src/oauth.mjs`, adaptado de Panter-ai `embedded-oauth.ts`): DCR, `/authorize` y consentimiento solo durante la ventana que abre el operador con `node src/cli.mjs remote-enroll <minutos>` y con la clave del operador. Fuera de la ventana no entra nadie nuevo; las conexiones aprobadas siguen y rotan su refresh token. Cada conexión queda atada a una etiqueta de host que elige el operador. El ledger OAuth vive en su propio SQLite (un restore de misiones nunca revive credenciales).
- `/health` responde sin autenticación con nombre, versión, modo, sesiones abiertas y estado del downstream.
- Host y Origin en allowlist (`ZANA_ALLOWED_ORIGINS`, por defecto `https://chatgpt.com`), cuerpo máximo 4 MB, `no-store`.
- Las `instructions` del servidor piden cargar `zana-odd` al empezar y `zana-4r` al recibir un ticket.

### Herramientas por modo

| Herramienta | stdio | remoto | Nota |
| --- | --- | --- | --- |
| `zana_profile`, `zana_capability_status` | sí | sí | |
| `zana_workspace_create`, `zana_workspace_get`, `zana_workspace_update` | no | sí | Borradores SQLite por cliente OAuth, control de versión, sin aprobar ni crear repositorios |
| `zana_discovery_start`, `zana_discovery_questions`, `zana_discovery_answer`, `zana_project_plan_draft` | no | sí | Fase de idea y plan sin repositorio; toda respuesta es borrador no persistido |
| `zana_bootstrap_prepare` | no | sí | Propuesta no persistida, no ejecuta create_repository ni concede autorización |
| `zana_mission_init` | sí | sí | En remoto exige `github: {repo, base}`, unidades `READ` y `code: true` en las que cambian código, y responde `memory` (contexto del proyecto y puntero, ver `docs/memory.md`) |
| `zana_mission_status`, `zana_next_batch`, `zana_mission_history` | sí | sí | |
| `zana_start_batch`, `zana_unit_heartbeat`, `zana_recover_expired`, `zana_unit_retry`, `zana_mission_cancel`, `zana_mission_close` | sí | sí | En remoto la unidad queda atada a la sesión; una sesión revisora no puede usarlas. El `zana_mission_close` remoto exige `summary` |
| `zana_complete_unit` | sí | sí | En remoto una unidad `code` exige check verde sobre el head actual de la rama, que se vuelve a leer después de los checks (`HEAD_MOVED`) |
| `zana_apply_write` | sí | **no** | Congelada (ZL-004) |
| `zana_review_open`, `zana_review_status`, `zana_review_next`, `zana_review_start`, `zana_review_submit`, `zana_review_check` | sí | **no** | Dependen de `git-evidence` local, congelado |
| `zana_storage_status`, `zana_storage_history`, `zana_storage_reviews`, `zana_permission_status` | sí | **no** | Administración local: CLI del operador en el servidor |
| `zana_memory_context`, `zana_memory_search` | no | sí | Lectura de la memoria por proyecto, también para la revisora |
| `zana_memory_save`, `zana_memory_resolve` | no | sí | Escritura de cualquier sesión de la misión que no sea la revisora, con la misión activa; la revisora recibe `REVIEWER_READ_ONLY` |
| `zana_session_status` | no | sí | Sesión, host, `createdAt` y rol en la misión activa |
| `zana_skill_list`, `zana_skill_load` | no | sí | Skills de `skills/`: `zana-odd` y `zana-pr` (autora), `zana-4r` (revisora), `review-discipline` y los cuatro `review-*` (lentes) |
| `zana_checks_start`, `zana_checks_status` | no | sí | Checks en GitHub Actions por SHA exacto |
| `zana_review_request`, `zana_review_claim`, `zana_review_diff`, `zana_review_lens_submit`, `zana_review_finalize` | no | sí | Ticket, conversación nueva, diff paginado completo y cuenta revisora |
| `zana_budget_extend` | no | sí | Escritura de la sesión autora, solo con el sí del usuario: `{missionId, lines, reason, scope, forSha, outOfScopeCount}`. Con `scope: 'pr'` (por defecto) sube el presupuesto de líneas de la misión tras `OVER_LINE_BUDGET` (máximo 5000); con `scope: 'correction'` autoriza, para el SHA, los archivos y las N líneas que midió el último rechazo de la ronda (`NO_CORRECTION_PENDING` si no hubo), hasta `lines`; exige `forSha` y `outOfScopeCount` iguales a los de ese rechazo (`CORRECTION_MISMATCH` si no, sin guardar nada), tras `OVER_CORRECTION_BUDGET`, `CORRECTION_OUT_OF_SCOPE` o `CORRECTION_UNMEASURED`, sin tocar la extensión `pr` (`NO_CHANGES_REQUESTED` si no hay ronda). Auditada como `write`; la revisora recibe `REVIEWER_READ_ONLY` |
| `zana_correction_start` | no | sí | Agrega una unidad de corrección tras `REQUEST_CHANGES` (el último ticket se revalida dentro de la transacción de la misión); `correctionBudget` informa los topes de la ronda: archivos del PR y tests, `maxLines` = `min(200, ceil(líneas del PR / 2))` |
| `zana_session_rebind` | no | sí | Pasa una unidad RUNNING con el lease vigente a la sesión actual (solo si `zana_session_status` da otro id que el que la tomó) sin consumir intento; vencido, `zana_recover_expired` → `zana_unit_retry` |
| `zana_mission_archive` | no | sí | Archiva una misión `CLOSED` o `CANCELLED` para iniciar otra |
| `zana_delivery_status` | no | sí | Solo lectura; la autoridad es el ticket vigente de la misión |
| `zana_merge` | no | sí | Solo con todo verde sobre un mismo head; `ZANA_MERGE_ENABLED=false` lo apaga |
| `zana_ds_github` | no | sí | Router del GitHub MCP oficial, ver `docs/downstream-github.md` |

Total: 24 en stdio y 42 en remoto. La restauración, la adopción de cuarentenas, la ventana de alta OAuth, la revocación de clientes, la auditoría (`remote-audit`), la salud con detalle (`remote-health`), los tickets (`remote-tickets`, `remote-ticket-abandon`) y el merge del operador (`remote-merge`) son solo CLI en el servidor.

### Plazos

Cada tool remota tiene un plazo total (`ZANA_TOOL_DEADLINE_MS`, 45 s por defecto). Si se excede responde `TOOL_DEADLINE`: la operación puede terminar igual, así que hay que leer el estado antes de reintentar. `zana_checks_status` y `zana_delivery_status` reparten ese plazo entre sus lecturas y devuelven `partial` con lo que no alcanzó (lo faltante nunca cuenta como verde; en `zana_delivery_status` también la lista de archivos de `lineBudget`, que es informativa); los logs de jobs fallidos tienen su propio presupuesto (10 s). La REST de GitHub tiene un circuit breaker compartido por los tokens autor y revisor: 5 fallos seguidos (red, 5xx o 429) lo abren 30 s.

### Auditoría

Cada llamada a una tool remota y cada llamada al downstream queda en `remote_audit` (SQLite v7): host, sesión, tool, misión, resultado y HMAC-SHA256 de los argumentos con una llave guardada en la DB. Cuando una tool falla, `detail.error` guarda los primeros 300 caracteres de su error, ya redactado. Cada fila tiene categoría (`read`, `write`, `refused`, `merge`, `review`, `operator`). Las lecturas son una ventana de las 5000 más recientes; el resto se guarda 365 días. La actividad de misiones no activas se borra a los 90 días, las sesiones inactivas a los 30, los checks a los 30 y los tickets terminales a los 180 (nunca los de la misión activa, que guardan sus bloqueos de mismo SHA). Las filas de actividad anteriores a `client_id` lo toman de su sesión al migrar. Nunca se guardan los argumentos ni un token; `tests/remote-http.test.mjs` y `tests/remote-downstream.test.mjs` comprueban la redacción.

## Limitaciones y siguientes gates

- Los contextos nativos y el modelo efectivo permanecen sin verificar.
- La reconexión y cancelación MCP no sustituyen leases, recibos y reconciliación de operaciones WRITE.
- El SDK y sus dependencias transitivas están fijados en `package-lock.json` v3; CI utiliza `npm ci --ignore-scripts`, un preflight estático y auditoría de dependencias de producción. El estado de release sigue bloqueado por requisitos externos de GitHub y del anfitrión.
- La interfaz local no puede impedir ediciones directas realizadas por herramientas externas que no pasen por el controlador.
- El deploy del modo remoto lo hace el operador (`docs/deploy-remote.md`); ningún agente mergea ni despliega por su cuenta.

## Herramienta `zana_apply_write` (ZL-004)

Entradas: `unitId`, `token`, `leaseGeneration`, `path` relativo y uno de `content` (texto UTF-8) o `deleteFile:true`. `expectedPreSha256` permite rechazar preimágenes inesperadas. La ejecución revalida el permiso Ed25519, lease, paths autorizados y cuota. Primero persiste una intención `OUTCOME_UNKNOWN`, luego aplica el efecto anclado a directorios Linux y confirma un recibo `preSha256/postSha256` en SQLite. Un fallo posterior a intención requiere conciliación firmada; **nunca volver a llamar automáticamente**.

La herramienta no garantiza que otras capacidades del host hayan sido deshabilitadas. Hay que ejecutar el agente con workspace read-only y otorgar escritura exclusivamente al proceso MCP, mediante SO o contenedor. Ver [seguridad y ciclo de vida](safety-lifecycle.md).

## Emisor de atestación CI (workflow_run, main-only)

**Versión del proyecto: ZanaLLaima 0.7.0.** El sobre Ed25519 `CI_RESULT` es producido por `scripts/ci-attest.mjs`, ejecutado por `.github/workflows/ci-attestation.yml` mediante `workflow_run` una vez que concluye `CI`. El script confiable se carga exclusivamente desde `main` (policy **main-only**) y consulta la API de GitHub para verificar los jobs, SHA, árbol, base, runId y conclusión. Jamás se ejecuta código o dependencias del HEAD del PR con `ZANA_CI_SIGNING_KEY`.

El environment `ci-attestation` exige como reviewer requerido la cuenta revisora (`ZANA_CI_REVIEWER` en `scripts/setup-ci-signing.sh`). Si pertenece al mismo dueño que la cuenta autora, la separación de cuentas no constituye independencia organizacional. La configuración debe impedir self-review y mantener solo `main` como deployment policy. El workflow permanece desactivado hasta configurar el secreto, la llave pública real y `ZANA_CI_ATTESTATION_READY=true` con controles humanos. La llave `keys/ci-verifier.pub` sigue siendo placeholder hasta entonces.

Para verificar el run firmado se usa `gh run list --workflow ci-attestation.yml`, `gh run view` y la descarga del artifact firmado. Ningún sobre CI sustituye la aprobación separada del operador ni autoriza merge o despliegue. Ver [operator-checklist.md](operator-checklist.md) y [release-security.md](release-security.md).
