# ZanaLLaima

Motor local de misiones para un único anfitrión GPT, con estado durable, revisión RDD vinculada a Git y transporte **MCP stdio**. No llama directamente a APIs de modelos ni envía tareas a cuentas externas.

## Estado del proyecto

| Componente | Estado |
| --- | --- |
| SQLite WAL, leases, reintentos READ y recuperación de interrupciones | Implementado y probado localmente |
| Planificación incremental READ y presupuestos por misión | Implementado; ejecución nativa de subagentes no verificada |
| Cuatro lentes RDD sobre un SHA Git exacto | Implementado; autocomprobación no equivale a revisión independiente |
| Herramienta de escrituras \`zana_apply_write\` con recibos SHA y permiso Ed25519 | Implementado localmente; aislamiento efectivo del anfitrión pendiente |
| MCP SDK oficial v2 por stdio | Implementado y probado con cliente oficial |
| CI reproducible en Node 22 y 24, auditoría y cobertura | Implementado; ver checks del SHA actual |
| Emisor de atestación CI Ed25519 | Código y workflow preparados; llave y environment pendientes de Zana |
| Integración real Codex, reporte de modelo/esfuerzo y subagentes | **PASO HUMANO**, sin pruebas reales todavía |
| Revisión independiente y merge | Pendiente de otra identidad autorizada y decisión humana |

**El PR #1 no autoriza merge ni despliegue.** Los resultados de prueba locales no prueban capacidades que solo puede mostrar el anfitrión.

## Requisitos y estructura

Node.js ≥22.16, Linux para efectos de escritura anclados a descriptores, Git, y dependencias fijadas en \`package-lock.json\`.

\`\`\`sh
git checkout feat/gpt-native-solo-engine
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run release:preflight
\`\`\`

Los módulos principales:

- \`src/core.mjs\` y \`src/lifecycle.mjs\`: DAG de unidades, claims, heartbeat, vencimiento y recuperación.
- \`src/store.mjs\`: SQLite WAL, estado, intentos, historial y recibos.
- \`src/budget.mjs\`: límites de tiempo, intentos, concurrencia y resultados.
- \`src/write-effect.mjs\` y \`src/write-operations.mjs\`: efectos de archivo y permisos de WRITE al momento de ejecutarlos.
- \`src/review.mjs\`, \`src/git-evidence.mjs\` y \`src/delivery.mjs\`: RDD y gate manual de entrega.
- \`src/mcp.mjs\`: servidor MCP oficial, local y sin HTTP.
- \`scripts/ci-attest.mjs\`: emisor de sobre CI firmado, solo con llave privada provista por Zana.

## Configuración local

\`\`\`sh
export ZANA_STATE_FILE=/ruta/segura/zana/state.json
export ZANA_WORKSPACE_ROOT=/ruta/absoluta/al/workspace
export ZANA_REVIEW_REPO=/ruta/absoluta/al/repo
export ZANA_REVIEW_TARGET_REF=refs/heads/main
node src/mcp.mjs
\`\`\`

El servidor dispone de **24 herramientas MCP**. El catálogo se comprueba automáticamente contra esta cifra en \`tests/sdk-mcp.test.mjs\`. Las herramientas MCP no administran claves privadas, no importan firmas del operador, no restauran respaldos ni hacen merge.

Las acciones administrativas siguen en el CLI local:

\`\`\`sh
node src/cli.mjs profile
node src/cli.mjs storage-status
node src/cli.mjs status
node src/cli.mjs storage-history 25
node src/cli.mjs operator-import /ruta/al/grant-firmado.json
\`\`\`

## Ciclo de misión y permiso WRITE

Una misión define \`objective\`, \`authorization\`, \`budget\` y unidades \`READ\`/\`WRITE\`. Los permisos declarados en el JSON **no** sustituyen el grant Ed25519 separado del operador.

El controlador reserva unidades con \`zana_next_batch\` y \`zana_start_batch\`, devuelve un \`token\` y \`leaseGeneration\`, y admite \`zana_complete_unit\` solo con evidencia factual. Las lecturas independientes pueden rellenar cupos mientras siguen ejecutándose otras; los escritores son exclusivos. La planificación de subagentes no demuestra que realmente se lanzaran.

Para modificar un archivo, una unidad WRITE debe pasar **obligatoriamente** por \`zana_apply_write\`: \`unitId\`, \`token\`, \`leaseGeneration\`, \`path\` relativo y \`content\` UTF-8 o \`deleteFile:true\`; opcionalmente \`expectedPreSha256\`. Revalida el grant, lease y ruta, persiste intención antes del efecto, aplica un cambio atómico anclado a descriptores Linux y registra SHA anterior/posterior.

Si el proceso muere después del efecto y antes del recibo, la unidad queda \`OUTCOME_UNKNOWN\`. **Nunca repetir el efecto automáticamente.** La reconciliación necesita evidencia y firma del operador.

**Límite crítico:** el MCP no puede deshabilitar herramientas externas del host. La producción requiere separar permisos del SO: usuario del host sin escritura sobre el workspace, proceso MCP ejecutado por usuario independiente autorizado o contenedor con el volumen del host en solo lectura. Ver [seguridad y ciclo de vida](docs/safety-lifecycle.md).

## Revisión RDD sobre Git

Con todas las unidades de la misión terminadas y el árbol de trabajo limpio, el RDD congela commit, árbol, rama y base. Ejecuta cuatro lentes: riesgo, fiabilidad, resiliencia y claridad.

\`\`\`sh
node src/cli.mjs review-open "$(git rev-parse HEAD)"
node src/cli.mjs review-next
node src/cli.mjs review-start
node src/cli.mjs review-status
node src/cli.mjs review-check
\`\`\`

Cada resultado lleva token y evidencia real. Si cambia el SHA o la base, se invalida el ciclo. Sin contextos nativos realmente observados, se usa revisión secuencial etiquetada \`SELF_CHECK_COMPLETE_UNVERIFIED\`. Ningún resultado concede aprobación de PR. Ver [contrato RDD](docs/solo-rdd.md).

## Atenciones de CI y entrega

El CI verifica el HEAD exacto, ejecuta pruebas en Node 22.16.0 / 22.23.4 / 24, estrés multiproceso, cobertura y auditoría de dependencias. La firma de `CI_RESULT` se ejecuta exclusivamente en `.github/workflows/ci-attestation.yml`, disparado por `workflow_run` desde el código confiable de `main`, cuando Zana configura el environment protegido y su secreto CI. Mientras no exista la configuración, no hay atestación auténtica y \`trustedCIAttribution\` permanece sin conectar.

El gate \`delivery-check\` requiere dos firmantes Ed25519 distintos: CI y operador. Incluso con ambos devuelve como máximo \`READY_FOR_MANUAL_RELEASE\`, nunca \`mergeAuthorized:true\`.

\`\`\`sh
npm run check
npm run release:preflight
npm test
npm run test:stress
npm run test:coverage
npm run benchmark:phase4
npm audit --omit=dev --audit-level=high
\`\`\`

Ver [auditoría de seguridad](docs/release-security.md) y [registro de cambios](CHANGELOG.md).

## Conexión y E2E con anfitrión

- [Guía de Codex CLI y MCP stdio](docs/host-codex.md)
- [Procedimiento y evidencia E2E que ejecuta Zana](docs/host-e2e.md)
- [Plantilla de observaciones](examples/host-e2e-report.json)
- [Estado y criterios pendientes](ROADMAP.md)

**ChatGPT web no puede ejecutar directamente el proceso stdio local.** Una conexión web necesita un servicio HTTP MCP autenticado mediante OAuth y controles de aislamiento adicionales. Ese transporte queda fuera de la versión 0.5.0.

La guía breve para completar los pasos humanos de la versión 0.5.0 es [docs/operator-checklist.md](docs/operator-checklist.md). La configuración de firma CI se realiza desde la máquina de Zana con `bash scripts/setup-ci-signing.sh`.
