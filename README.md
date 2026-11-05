# ZanaLLaima

Harness de misiones para **la app de ChatGPT**, servido como **MCP remoto** en zana-main. No llama a APIs de modelos, no tiene shell ni CLI para GPT y no depende de otros coordinadores. Versión 0.6.0, sin publicar.

```
App ChatGPT (GPT + subagentes)
   │ MCP Streamable HTTP + OAuth (registro cerrado)
   ▼
ZanaLLaima (zana-main, loopback + túnel Cloudflare)
   ├─ misiones / unidades / presupuestos / leases
   ├─ skills por MCP (zana-odd, zana-4r, review-*)
   ├─ tickets de revisión + 4 lentes por SHA
   ├─ review publicada con la cuenta revisora
   └─ downstream ──▶ GitHub MCP oficial ──▶ GitHub Actions corre los tests
```

**Cómo se trabaja:**

1. **Conversación autora.** GPT carga `zana-odd`, crea una misión con `github: {repo, base}`, reserva unidades y escribe en GitHub **solo** por `zana_ds_github`, **solo** en `zana/<missionId>` y solo mientras su sesión tiene una unidad `RUNNING`. Los tests corren en Actions (`zana_checks_start`/`zana_checks_status`); una unidad de código no se completa sin check verde sobre su SHA final. Abre el PR y pide un ticket (`zana_review_request`).
2. **Conversación revisora (nueva).** El usuario pega "Revisa el ticket ZR-... con ZanaLLaima". Esa sesión reclama el ticket (no puede ser la autora, no pudo haber escrito y debe ser posterior al ticket), queda en solo lectura, corre los 4 lentes con `zana-4r` y finaliza. ZanaLLaima relee el head del PR: si cambió, `STALE_SHA`; si no, publica la review **firmada por `sebastianriquelme95-max`** sobre ese SHA y el status `zana/4r`.
3. **Entrega.** `zana_delivery_status` muestra aprobación exacta, CI, `zana/4r` y mergeable. `zana_merge` solo mergea con todo verde sobre el mismo head (`sha` = head verificado). La protección de `main` es la segunda llave.

**La verdad es el SHA en GitHub y sus checks.** Los tokens (autor y revisora) viven solo en el servidor; nunca en el repo, en logs ni en resultados de tools. Qué prueba y qué no la separación de sesiones: [docs/solo-rdd.md](docs/solo-rdd.md).

| Tema | Documento |
| --- | --- |
| Deploy en zana-main (lo hace el operador) | [docs/deploy-remote.md](docs/deploy-remote.md) |
| Tools por modo y transporte | [docs/mcp-v2.md](docs/mcp-v2.md) |
| GitHub MCP, política y lista real de tools | [docs/downstream-github.md](docs/downstream-github.md) |
| Workflow de checks para repos administrados | [docs/checks-workflow.md](docs/checks-workflow.md) |
| E2E real con la app de ChatGPT (ZL-018) | [docs/host-e2e-remote.md](docs/host-e2e-remote.md) |

## Estado del proyecto

| Componente | Estado |
| --- | --- |
| Modo remoto: HTTP con sesiones, OAuth con registro cerrado, `/health` | Implementado y probado con el cliente oficial contra servidores falsos locales |
| Downstream GitHub MCP y política allowlist (v2.1.0) | Implementado y probado con un MCP falso; sin contacto real con `api.githubcopilot.com` |
| Checks, tickets, lentes, review con cuenta revisora, delivery y merge | Implementado y probado contra una API de GitHub falsa |
| E2E real con la app de ChatGPT y separación de sesiones | **PASO DEL OPERADOR**, sin observar |
| SQLite WAL, leases, reintentos y recuperación | Implementado y probado |
| Modo stdio local, `zana_apply_write`, RDD local con `git-evidence`, grants Ed25519 | Implementado; **congelado** por el cambio de rumbo |

**Este PR no autoriza merge ni despliegue.** Los tests locales no prueban capacidades que solo puede mostrar el anfitrión real.

## Requisitos y estructura

Node.js ≥22.16, Linux para efectos de escritura anclados a descriptores, Git, y dependencias fijadas en \`package-lock.json\`.

\`\`\`sh
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

## Modo local stdio (congelado)

\`\`\`sh
export ZANA_STATE_FILE=/ruta/segura/zana/state.json
export ZANA_WORKSPACE_ROOT=/ruta/absoluta/al/workspace
export ZANA_REVIEW_REPO=/ruta/absoluta/al/repo
export ZANA_REVIEW_TARGET_REF=refs/heads/main
node src/mcp.mjs
\`\`\`

En modo stdio el servidor dispone de **24 herramientas MCP**. El catálogo se comprueba automáticamente contra esta cifra en \`tests/sdk-mcp.test.mjs\`. Las herramientas stdio no administran claves privadas, no importan firmas del operador, no restauran respaldos ni hacen merge. El modo remoto expone 25 (ver [docs/mcp-v2.md](docs/mcp-v2.md)), entre ellas `zana_merge` con sus condiciones.

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

**ChatGPT no ejecuta el proceso stdio local.** Para la app de ChatGPT se usa el modo remoto de arriba; el modo stdio queda para pruebas y uso local, sin cambios.

La guía breve para los pasos humanos de la versión 0.6.0 es [docs/operator-checklist.md](docs/operator-checklist.md). La configuración de firma CI se realiza desde la máquina de Zana con `bash scripts/setup-ci-signing.sh`.
