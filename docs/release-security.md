# Fase 5: auditoría de CI, seguridad del repositorio y release

**Fecha de corte:** 2026-11-04. **Repositorio:** `riquelmechile/ZanaLLaima`. **PR:** #1, rama `feat/gpt-native-solo-engine`. Esta evaluación documenta seguridad de entrega, no certifica que los agentes o el anfitrión GPT hayan sido probados realmente.

## Qué controla el CI

- Se utiliza **una ejecución por actualización del PR**: evento `pull_request`. El evento `push` se limita a `main`; `workflow_dispatch` es manual.
- El checkout usa el SHA explícito `github.event.pull_request.head.sha || github.sha` y comprueba `git rev-parse HEAD` antes de ejecutar código. El runner opera con permisos `contents: read`, `persist-credentials: false`, sin secretos de despliegue.
- Acciones oficiales fijadas a commits: checkout v4.2.2 `11bd71901bbe5b1630ceea73d27597364c9af683` y setup-node v4.4.0 `49933ea5288caeca8642d1e84afbd3f7d6820020`, verificados contra sus tags de GitHub.
- Instalación reproducible: `npm ci --ignore-scripts --no-audit --no-fund` con `package-lock.json` v3, resoluciones del registry npm y hashes de integridad de las dependencias. Sin instalación dinámica `npm install` en CI.
- Matriz: Node **22.16.0**, **22.23.4** y **24**, cada uno con sintaxis, preflight, suite de integración y estrés. Cobertura de `src/*.mjs` medida en Node 22.23.4; umbrales mínimos **90 % líneas, 80 % ramas y 85 % funciones** (no se cuentan los tests para aprobar los umbrales).
- Auditoría de producción: `npm audit --omit=dev --audit-level=high`, con fallo ante vulnerabilidades altas o críticas. Los resultados son específicos del commit y de la fecha del análisis, no una garantía perpetua.
- `timeout-minutes: 20`, `cancel-in-progress: true`, `strategy.fail-fast: false`. No se publican artefactos de release ni se hace merge o deploy.

El comando `npm run release:preflight` valida localmente la integridad estática del lockfile, versiones, acciones fijadas, permisos read-only, checkout del SHA exacto y ausencia de claves privadas rastreadas. Su salida incluye invariablemente `releaseAuthorized:false`: **no** es autoridad para hacer merge ni para desplegar.

**Evidencia de referencia:** el CI del SHA `d7fe3e8fac692d57407fb1a05d372d2e394c9d83` superó las tres versiones Node. En Node 22.23.4 midió 95,39 % de líneas de código fuente, 82,19 % de ramas y 88,83 % de funciones; el audit de producción informó cero vulnerabilidades. Los siguientes commits deben superar los nuevos umbrales sobre su propio SHA, no reutilizar esa ejecución.

## Hallazgos y puertas de seguridad

| Hallazgo | Severidad | Evidencia / mitigación | Estado |
| --- | --- | --- | --- |
| GitHub `main` sin protección (hallazgo inicial) | **RESUELTO** | Branch protection activada con sesión administrativa; GET de GitHub confirma `protected=true` y tres checks obligatorios | ZL-026 verificado |
| Escritor externo puede eludir el controlador MCP | **BLOCKER** | Firmas y rutas verificadas al reservar, no en toda mutación del ejecutor real; riesgo TOCTOU/symlink | Pendiente ZL-004 |
| Host GPT y subagentes no autenticados | **BLOCKER** | No se ha conectado ni medido un host real; no inferir modelo o independencia | Pendiente ZL-018 |
| Atentación CI preparada pero sin firma real | **HIGH** | Emisor y job `attest` implementados, aún sin llave pública auténtica, secreto o environment protegido | PASO HUMANO |
| Sin revisión de PR verdaderamente independiente | **HIGH** | PR en borrador; una sola cuenta no convierte autocomprobaciones en revisión independiente | Pendiente |
| Planificador incremental y métricas (Fase 4) | **RESUELTO LOCALMENTE** | Reposición READ, writer único y cuotas SQLite v4 con tests y benchmark; throughput del host GPT todavía no medido | E2E host pendiente |
| Dependencias y acciones sin bloqueo previo | **HIGH, resuelto localmente** | Lockfile npm, `npm ci`, pins SHA, pruebas en matriz y auditoría de producción | Implementado |
| Eventos de CI duplicados | **MEDIUM, resuelto localmente** | Separación `pull_request` vs. `push: main` y cancelación por grupo | Implementado |
| SQLite experimental en Node 22 | **MEDIUM** | Pruebas en Node 22.16.0 y 22.23.4; compatibilidad también probada en Node 24 | Riesgo aceptado para desarrollo, no producción |

**Ningún gate de entrega permite merge o despliegue automáticamente**, incluso cuando un resultado firmado devuelve `READY_FOR_MANUAL_RELEASE`. El operador debe comprobar la autoridad real y autorizar cada acción por separado.

## Protección de GitHub aplicada y comprobada (ZL-026)

**Estado verificado:** la rama `main` ya está protegida. El conector GitHub de archivos seguía devolviendo `403` para acciones de administración, pero una sesión GitHub CLI autenticada como administrador del repositorio (`riquelmechile`) pudo configurar la protección por API. Tras el cambio, tanto un GET administrativo a `/branches/main/protection` como la lectura general de `/branches/main` confirmaron las reglas y `protected=true`.

Configuración activa, recuperada por GET:

1. `required_status_checks.strict=true` y exactamente tres checks de GitHub Actions: `test (Node 22.16.0)`, `test (Node 22.23.4)`, `test (Node 24)`, asociados a GitHub Actions `app_id=15368`.
2. `required_pull_request_reviews.required_approving_review_count=1`: se requiere aprobación de PR. `dismiss_stale_reviews=true` y `require_last_push_approval=true` rechazan aprobaciones anteriores o del autor del último push.
3. `required_conversation_resolution.enabled=true`, `enforce_admins.enabled=true`: conversaciones resueltas y controles aplicados a administradores.
4. `allow_force_pushes.enabled=false` y `allow_deletions.enabled=false`: sin force-push ni eliminación de la rama protegida.

Se configuró **branch protection**, no se creó un ruleset. El endpoint `/rulesets` podría seguir devolviendo `[]` y eso no contradice la protección activa de `main`.

**Nota:** los checks y la revisión independiente siguen siendo requisitos para una futura solicitud de merge. Configurar estas reglas no crea ni simula una revisión formal. La protección tampoco sustituye los gates del ejecutor, del host GPT o del verificador externo de CI; no habilita despliegues automáticos.

**Invariante administrativo:** revisar y conservar estas reglas antes de cualquier merge. No reducirlas durante operaciones rutinarias ni asumir que un job verde concede permiso de release.

## Gates que siguen impidiendo release

- **ZL-004:** validar permisos al aplicar cada mutación del ejecutor real, no solo en el plan.
- **ZL-018:** conectividad ChatGPT real, modelo/esfuerzo observado y subagentes cuando existan.
- **Fase 4:** implementación y benchmark locales completos; queda observar throughput nativo real y enforcement de escrituras al integrar ChatGPT.
- **Gobernanza:** protección de `main` activa; falta recibir una revisión realmente independiente sobre el SHA exacto.
- **CI confiable:** fuente auténtica de atestaciones CI vinculadas al SHA y al runner, separada del propio modelo.

Un informe local, un PDF, una ejecución de pruebas o una firma suministrada por el propio agente **no** reemplaza estas evidencias. El proyecto permanece local, sin servidor HTTP ni entrega automática.

## Comandos para repetir la comprobación

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run release:preflight
npm test
npm run test:stress
npm run test:coverage
npm audit --omit=dev --audit-level=high
```

Verificar el estado del PR y la rama de destino desde una cuenta autorizada antes de cualquier merge; **no** reutilizar resultados de otro commit.


## Seguimiento de Fase 4

El planificador local ya admite reposición incremental READ mientras otros tokens están en RUNNING y SQLite impide guardar escritores simultáneos. Los presupuestos se conservan en SQLite v5 (tabla de recibos WRITE incluida); los tests negativos cubren snapshots falsificados y contadores agotados. El benchmark produce métricas p50/p95 locales y un modelo determinista de throughput, **no** una validación de capacidad de subagentes ni una ganancia medida de la cuenta GPT. La conexión real, los recibos CI firmados y el control del ejecutor siguen abiertos. Ver [phase4-performance.md](phase4-performance.md).


## Activación CI Ed25519: PASO HUMANO (Zana)

El job `attest` y el script `scripts/ci-attest.mjs` están preparados, pero todavía **no existe una atestación auténtica**. `keys/ci-verifier.pub` contiene texto de configuración, no una llave pública verificable. Zana debe generar la pareja de llaves localmente, sin mostrar al modelo la privada:

```sh
umask 077
mkdir -p "$HOME/.config/zana-llaima"
openssl genpkey -algorithm Ed25519 \
  -out "$HOME/.config/zana-llaima/ci-attest-private.pem"
cd /home/zana/ZanaLLaima
openssl pkey -in "$HOME/.config/zana-llaima/ci-attest-private.pem" \
  -pubout > keys/ci-verifier.pub

gh api --method PUT \
  repos/riquelmechile/ZanaLLaima/environments/ci-attestation

gh secret set ZANA_CI_SIGNING_KEY \
  --repo riquelmechile/ZanaLLaima \
  --env ci-attestation \
  < "$HOME/.config/zana-llaima/ci-attest-private.pem"
```

**Antes de activarlo:** agregar al environment protección de ramas autorizadas y aprobador humano independiente. Un PR del mismo repositorio podría editar el workflow: no exponer la llave de CI sin una revisión previa del código que va a ejecutar. Cuando estén activas las protecciones y commiteada **solo** la llave pública real:

```sh
gh variable set ZANA_CI_ATTESTATION_READY \
  --repo riquelmechile/ZanaLLaima --body true
```

La llave de CI debe ser diferente de la privada del operador. El cambio de llave pública altera el SHA del PR y exige repetir CI y revisión. El job, si se ejecuta con secreto válido después de la matriz verde, carga el artifact `ci-attestation-<SHA>` con vigencia limitada. Sin secreto válido, falla cerrado; si aún no está habilitado, queda omitido.

Validar el sobre de CI y la aprobación separada del operador:

```sh
export ZANA_CI_PUBLIC_KEY_PATH=/home/zana/ZanaLLaima/keys/ci-verifier.pub
export ZANA_OPERATOR_PUBLIC_KEY_PATH="$HOME/.config/zana-llaima/operator-public.pem"
node src/cli.mjs delivery-check /ruta/ci-attestation.json /ruta/aprobacion-operador.json
```

El gate podrá informar como máximo `READY_FOR_MANUAL_RELEASE`; `releaseAuthorized:false`, la necesidad de revisión independiente y la prohibición de merge/deploy automático se mantienen. El host aún debe ejecutar y documentar las pruebas de aislamiento real de SO (ZL-004 operacional) y Codex (ZL-018).

## PASO HUMANO: segunda cuenta para la revisión del PR

La protección de `main` requiere una aprobación de GitHub distinta del autor y de quien hizo el último push. Zana puede invitar su segunda cuenta, con un nombre real que ella elija:

```sh
gh api --method PUT \
  repos/riquelmechile/ZanaLLaima/collaborators/SEGUNDA_CUENTA \
  -f permission=push
```

Tras aceptar la invitación y examinar el SHA final, la segunda cuenta debe revisar el PR de forma independiente. Estos comandos se ejecutan **solo autenticado como la segunda cuenta**, no mediante el autor:

```sh
gh pr view 1 --repo riquelmechile/ZanaLLaima \
  --json headRefOid,isDraft,reviewDecision,statusCheckRollup
gh pr review 1 --repo riquelmechile/ZanaLLaima --approve \
  --body "Revisión independiente del SHA exacto y pruebas verificadas, sin bloqueantes"
```

No se genera esa aprobación durante este cierre ni se invita ninguna cuenta sin un identificador aportado por Zana.
