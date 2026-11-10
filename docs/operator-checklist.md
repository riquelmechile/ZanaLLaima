# Checklist del operador: ZanaLLaima 0.7.0

**PASOS HUMANOS.** Ningún resultado de CI concede permiso de merge ni despliegue. La llave privada permanece fuera del repositorio, de chats y del proceso MCP.

## 1. Revisora 4R y autorizaciones separadas

La cuenta requerida para el environment `ci-attestation` es la cuenta revisora, que el script recibe en `ZANA_CI_REVIEWER` (nunca queda escrita en el repo). Si es del mismo dueño que la cuenta autora, no presentar esa separación de credenciales como independencia organizacional. Antes de cualquier aprobación, verificar HEAD exacto, revisión 4R y protección de `main`. El script de configuración debe mantener `prevent_self_review=true`.

```sh
gh auth status
gh pr view 1 --repo <owner>/ZanaLLaima --json headRefOid,reviewDecision,statusCheckRollup,isDraft
gh pr checks 1 --repo <owner>/ZanaLLaima
```

## 2. Firma CI segura por workflow_run (main-only)

Desde una máquina controlada por el operador (no desde el MCP). `scripts/setup-ci-signing.sh` y `scripts/ci-attest.mjs` fijan el repo canónico en `REPO`; en un fork, cambia ese valor antes de correrlos:

```sh
git switch feat/gpt-native-solo-engine
git pull --ff-only
bash scripts/setup-ci-signing.sh --dry-run
ZANA_CI_REVIEWER=<cuenta-revisora> bash scripts/setup-ci-signing.sh
```

El script exige reviewer en el environment `ci-attestation` y **policy solo main**. No habilitar políticas para ramas de PR ni para referencias de merge del PR. La llave privada `ZANA_CI_SIGNING_KEY` solo se expone a `.github/workflows/ci-attestation.yml` con evento `workflow_run`, checkout confiable de `main` y ningún paso que ejecute código del HEAD del PR con el secreto.

Revisar las reglas y habilitar la variable **únicamente después** de validar la configuración y publicar la llave pública CI:

```sh
gh api repos/<owner>/ZanaLLaima/environments/ci-attestation
gh api repos/<owner>/ZanaLLaima/environments/ci-attestation/deployment-branch-policies
gh variable set ZANA_CI_ATTESTATION_READY --repo <owner>/ZanaLLaima --body true
```

**Gate:** la lista de deployment policies contiene exactamente `main` y un required reviewer configurado; se mantiene protección contra revisión del propio actor. Si no se puede verificar, dejar `ZANA_CI_ATTESTATION_READY=false`.

## 3. Comprobar la atestación auténtica

La firma no es un job de `.github/workflows/ci.yml`. Se dispara cuando termina `CI` y usa el workflow separado:

```sh
gh run list --repo <owner>/ZanaLLaima --workflow ci-attestation.yml --limit 10 --json databaseId,event,headSha,status,conclusion
gh run view <RUN_ID> --repo <owner>/ZanaLLaima --json event,headSha,status,conclusion,jobs
gh run download <RUN_ID> --repo <owner>/ZanaLLaima --name ci-attestation-<PR_HEAD_SHA>
```

**Criterio de éxito:** el evento es `workflow_run`, el código del firmante proviene de `main`, el job del environment protegido termina `success` y existe un artifact `ci-attestation-<PR_HEAD_SHA>` que verifica la firma Ed25519 con `keys/ci-verifier.pub`. Confirmar que SHA, árbol, base y runId coinciden con el run `CI` verde del PR. Ejecutar `delivery-check` con una aprobación Ed25519 **independiente** del operador. Un run `skipped`, artifact ausente o firma inválida bloquea release.

## 4. Comprobar host real y efectos WRITE

Seguir [host-codex.md](host-codex.md) y [host-e2e.md](host-e2e.md). Comprobar los 24 endpoints MCP locales, las pruebas E2E reales del anfitrión y el aislamiento del sistema operativo que impide escrituras directas fuera del proceso autorizado. No declarar verificado modelo, esfuerzo, subagentes o seguridad cuando solo existen pruebas del controlador.

## 5. Decisión humana posterior

Comprobar nuevamente el SHA exacto y revisión 4R de la cuenta revisora. No aprobar desde la cuenta autora, no descartar `CHANGES_REQUESTED` y no hacer merge, tag ni deploy desde este procedimiento sin una autorización humana posterior y explícita.

## Modo remoto

- Deploy y alta de cuentas: [deploy-remote.md](deploy-remote.md).
- Workflow de checks en cada repo administrado: [checks-workflow.md](checks-workflow.md).
- E2E real con la app de ChatGPT: [host-e2e-remote.md](host-e2e-remote.md).
