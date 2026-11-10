# Fase 5: auditoría de CI, seguridad del repositorio y release

**Versión del proyecto: ZanaLLaima 0.7.0.** Firma CI por `workflow_run` en `ci-attestation.yml`, política **main-only** y reviewer humano requerido en el environment `ci-attestation`.

## Qué es la release 0.7.0 y qué no

Es una versión **alfa** para instalaciones de un solo operador, en uso real desde el 9 de noviembre de 2026. Se publica con el tag `v0.7.0` por decisión del operador. El resto de este documento es la auditoría de la fase 5, hecha antes del modo remoto: sus hallazgos sobre el modo stdio siguen valiendo para ese modo, que está congelado.

| Puerta | Estado en esta versión |
| --- | --- |
| `main` protegida: 3 checks, 1 aprobación sobre el último push, sin excepción para admins | Activa |
| Revisión de cada PR sobre el SHA exacto | Hecha: 4R en otra sesión y aprobación de la cuenta revisora. Las dos cuentas son del mismo dueño: es separación de credenciales, no independencia organizacional |
| ZL-018: prueba con la app de ChatGPT | Parcial. El camino feliz y una ronda de corrección se observaron el 9 nov 2026 (`examples/host-e2e-remote.json`, palabra del operador, sin extracto de auditoría). El modelo, el esfuerzo y los subagentes siguen siendo palabra del host |
| Casos negativos del E2E en vivo | Sin observar; probados solo contra servidores falsos |
| Atestación CI Ed25519 (`ci-attestation.yml`) | Sin activar: sigue siendo paso humano. `release:preflight` responde `releaseAuthorized:false`, que aplica al gate de entrega del modo stdio |
| ZL-004: permisos en cada mutación del ejecutor local | Congelado con el modo stdio |

No se publican artefactos firmados ni paquetes: la release es un tag sobre un commit de `main` con CI verde.

## Complemento de seguridad versión histórica (no publicado)

La revisión Codex sobre `dc2c443` identificó filtros ejecutables en submódulos y en configuración Git por worktree/inclusiones, además de grants revocados que un respaldo antiguo podía reactivar. El observador Git ahora lee blobs y modos sin `git status` ni filtros; los grants revocados y nonces consumidos son monótonos frente al restore. Ni el consentimiento para perder datos elimina una revocación conocida. Una DB viva ilegible solo admite restore explícitamente forzado con todos los grants recuperados revocados. Sigue siendo obligatorio verificar CI y revisión independiente en el SHA final.


**Fecha de corte:** 2026-11-04. **Repositorio:** este repositorio. **PR:** #1, rama `feat/gpt-native-solo-engine`. Esta evaluación documenta seguridad de entrega, no certifica que los agentes o el anfitrión GPT hayan sido probados realmente.

## Qué controla el CI

- Se utiliza **una ejecución por actualización del PR**: evento `pull_request`. El evento `push` se limita a `main`; `workflow_dispatch` es manual.
- El checkout usa el SHA explícito `github.event.pull_request.head.sha || github.sha` y comprueba `git rev-parse HEAD` antes de ejecutar código. El runner opera con permisos `contents: read`, `persist-credentials: false`, sin secretos de despliegue.
- Acciones oficiales fijadas a commits: checkout v4.2.2 `11bd71901bbe5b1630ceea73d27597364c9af683` y setup-node v4.4.0 `49933ea5288caeca8642d1e84afbd3f7d6820020`, verificados contra sus tags de GitHub.
- Instalación reproducible: `npm ci --ignore-scripts --no-audit --no-fund` con `package-lock.json` v3, resoluciones del registry npm y hashes de integridad de las dependencias. Sin instalación dinámica `npm install` en CI.
- Matriz: Node **22.16.0**, **22.23.4** y **24**, cada uno con sintaxis, preflight, suite de integración y estrés. Cobertura de `src/*.mjs` medida en Node 22.23.4; umbrales mínimos **92 % líneas, 85 % ramas y 90 % funciones** (no se cuentan los tests para aprobar los umbrales).
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
| Atestación CI preparada pero sin firma real | **HIGH** | Firmante `ci-attestation.yml` en `workflow_run` de `main`, pendiente llave pública auténtica, secreto, reviewer y environment protegido | PASO HUMANO |
| Sin revisión de PR verdaderamente independiente | **HIGH** | PR en borrador; una sola cuenta no convierte autocomprobaciones en revisión independiente | Pendiente |
| Planificador incremental y métricas (Fase 4) | **RESUELTO LOCALMENTE** | Reposición READ, writer único y cuotas SQLite v4 con tests y benchmark; throughput del host GPT todavía no medido | E2E host pendiente |
| Dependencias y acciones sin bloqueo previo | **HIGH, resuelto localmente** | Lockfile npm, `npm ci`, pins SHA, pruebas en matriz y auditoría de producción | Implementado |
| Eventos de CI duplicados | **MEDIUM, resuelto localmente** | Separación `pull_request` vs. `push: main` y cancelación por grupo | Implementado |
| SQLite experimental en Node 22 | **MEDIUM** | Pruebas en Node 22.16.0 y 22.23.4; compatibilidad también probada en Node 24 | Riesgo aceptado para desarrollo, no producción |

**Ningún gate de entrega permite merge o despliegue automáticamente**, incluso cuando un resultado firmado devuelve `READY_FOR_MANUAL_RELEASE`. El operador debe comprobar la autoridad real y autorizar cada acción por separado.

## Protección de GitHub aplicada y comprobada (ZL-026)

**Estado verificado:** la rama `main` ya está protegida. El conector GitHub de archivos seguía devolviendo `403` para acciones de administración, pero una sesión GitHub CLI autenticada como administrador del repositorio pudo configurar la protección por API. Tras el cambio, tanto un GET administrativo a `/branches/main/protection` como la lectura general de `/branches/main` confirmaron las reglas y `protected=true`.

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

Un informe local, un PDF, una ejecución de pruebas o una firma suministrada por el propio agente **no** reemplaza estas evidencias. Esta lista se escribió para el modo stdio, que no tiene servidor HTTP ni entrega automática; el estado del modo remoto está en la tabla del inicio.

## Comandos para repetir la comprobación

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run release:preflight
npm test
npm run test:stress
npm run test:coverage
npm run benchmark:phase4
npm audit --omit=dev --audit-level=high
```

Verificar el estado del PR y la rama de destino desde una cuenta autorizada antes de cualquier merge; **no** reutilizar resultados de otro commit.


## Seguimiento de Fase 4

El planificador local ya admite reposición incremental READ mientras otros tokens están en RUNNING y SQLite impide guardar escritores simultáneos. Los presupuestos se conservan en SQLite v6 (tabla de recibos WRITE incluida); los tests negativos cubren snapshots falsificados y contadores agotados. El benchmark produce métricas p50/p95 locales y un modelo determinista de throughput, **no** una validación de capacidad de subagentes ni una ganancia medida de la cuenta GPT. La conexión real, los recibos CI firmados y el control del ejecutor siguen abiertos. Ver [phase4-performance.md](phase4-performance.md).


## Activación CI Ed25519: PASO HUMANO (operador)

La configuración completa se ejecuta exclusivamente en la máquina del operador mediante:

```sh
bash scripts/setup-ci-signing.sh
```

La simulación que no modifica archivos ni recursos remotos es:

```sh
bash scripts/setup-ci-signing.sh --dry-run
```

El script conserva una llave existente sin sobrescribirla, exige el modo 0600 y compara huellas de llaves **públicas** CI/operador para impedir reutilizar el mismo firmante. El secreto se transmite por entrada estándar de GitHub CLI y nunca se muestra en la salida.

**C1: se elige la opción B (`workflow_run`)**. El firmante se ejecuta exclusivamente desde el workflow cargado por GitHub en la rama protegida `main`, tras concluir el CI del PR. El checkout usa el SHA confiable de `main` y queda aislado en `trusted`, no el HEAD del PR. No instala dependencias ni ejecuta código del candidato con el secreto de firma disponible. El script del firmante consulta la API de GitHub para verificar el resultado `success`, los tres jobs de Node, sus pasos obligatorios, SHA/árbol y base, y compara byte a byte el workflow CI del HEAD con el archivo CI confiable de `main`, rechazando los PR que alteren el workflow aunque tengan checks verdes. **Consecuencia:** esta modificación del propio CI no puede recibir una atestación firmada hasta que el workflow sea revisado e incorporado a `main` mediante el proceso humano. `setup-ci-signing.sh` exige a la cuenta revisora (`ZANA_CI_REVIEWER`) como required reviewer del environment `ci-attestation`, elimina las policies de rama feature y `refs/pull/*`, y confirma que `main` sea la única rama autorizada. El secreto continúa desactivado hasta la acción explícita del operador.

El archivo `keys/ci-verifier.pub` sigue siendo un marcador hasta que el operador ejecute el script. `trustedCIAttribution` continúa `NOT_CONNECTED` y `releaseAuthorized:false` aunque la llave pública tenga formato correcto; hace falta un artifact CI firmado real y una aprobación separada del operador.

Para el orden humano completo, ver [operator-checklist.md](operator-checklist.md).

## PASO HUMANO: segunda cuenta para la revisión del PR

La protección de `main` requiere una aprobación de GitHub distinta del autor y de quien hizo el último push. El operador puede invitar su segunda cuenta, con un nombre real que ella elija:

```sh
gh api --method PUT \
  repos/<owner>/ZanaLLaima/collaborators/<cuenta-revisora> \
  -f permission=push
```

Tras aceptar la invitación y examinar el SHA final, la segunda cuenta debe revisar el PR de forma independiente. Estos comandos se ejecutan **solo autenticado como la segunda cuenta**, no mediante el autor:

```sh
gh pr view 1 --repo <owner>/ZanaLLaima \
  --json headRefOid,isDraft,reviewDecision,statusCheckRollup
gh pr review 1 --repo <owner>/ZanaLLaima --approve \
  --body "Revisión independiente del SHA exacto y pruebas verificadas, sin bloqueantes"
```

No se genera esa aprobación durante este cierre ni se invita ninguna cuenta sin un identificador aportado por el operador.

### Seguridad del restore offline versión histórica

La restauración se prepara sobre una copia temporal con migración de esquema y comprobación de integridad antes de mover la DB viva a cuarentena. No sobrescribe una DB con `OUTCOME_UNKNOWN`, intenciones de efecto aún sin recibo o recibos durables ausentes en el backup, salvo autorización manual explícita `--force-data-loss` con el modo offline. Cuando la base viva no se puede inspeccionar se exige el mismo flag. Ante fallo tras cuarentena, se restituye la base anterior.
