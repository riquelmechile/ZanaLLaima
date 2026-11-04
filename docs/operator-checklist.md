# Checklist del operador: ZanaLLaima 0.3.2

**PASOS HUMANOS.** No se autoriza merge ni despliegue. Mantener toda llave privada fuera de repositorios, chats y registros.

## 1. Revisora independiente

La invitación `#341594453` para `sebastianriquelme95-max` fue enviada, aún debe aceptarse. Acceder desde esa cuenta:

```sh
gh auth status
gh api --method PATCH user/repository_invitations/341594453
gh pr view 1 --repo riquelmechile/ZanaLLaima --web
```

**Criterio:** la revisora accede con permiso `push`, inspecciona código y CI y usa GitHub para aprobar personalmente. Toda aprobación anterior a los próximos commits deberá repetirse **tras el último push**, por `require_last_push_approval`.

## 2. Firma CI de Ed25519

En el checkout local de Zana:

```sh
git switch feat/gpt-native-solo-engine
git pull --ff-only
bash scripts/setup-ci-signing.sh --dry-run
bash scripts/setup-ci-signing.sh
```

**Criterio:** el script muestra únicamente huella SHA-256 pública y siguientes pasos; el environment limita referencias a `main`, `feat/gpt-native-solo-engine` y `refs/pull/1/merge` (referencia de ejecución del PR #1), la firma CI usa una clave distinta de la del operador y la variable de habilitación continúa desactivada. Revisar y habilitar reglas de aprobación humana del environment antes de activar la variable:

```sh
gh variable set ZANA_CI_ATTESTATION_READY --repo riquelmechile/ZanaLLaima --body true
git add keys/ci-verifier.pub
git commit -m "chore(ci): publicar verificador público de CI"
git push origin feat/gpt-native-solo-engine
gh run list --repo riquelmechile/ZanaLLaima --workflow ci.yml --limit 5
```

**Criterio posterior:** `attest` finaliza correctamente para el SHA nuevo. Descargar el artifact `ci-attestation-<SHA>` y verificarlo con `delivery-check` y una aprobación Ed25519 independiente del operador. Un gate cerrado no equivale a éxito.

## 3. Conectar Codex CLI

Seguir [host-codex.md](host-codex.md) y comprobar:

```sh
codex --version
codex mcp list
codex mcp get zana-llaima
```

**Criterio:** aparecen las 24 herramientas MCP y el SO impide escrituras directas fuera de `zana_apply_write`.

## 4. E2E real

Ejecutar [host-e2e.md](host-e2e.md), registrar únicamente lo observado y publicar el reporte:

```sh
git add examples/host-e2e-report.json
git commit -m "test(host): registrar verificación E2E real"
git push origin feat/gpt-native-solo-engine
```

**Criterio:** READ, refill, WRITE firmado, recuperación y 4R tienen evidencia. Conservar `HOST_REPORTED_UNVERIFIED` cuando no se pueda verificar una capacidad.

## 5. Decisión humana de merge

```sh
gh pr view 1 --repo riquelmechile/ZanaLLaima --json headRefOid,reviewDecision,statusCheckRollup,isDraft
gh pr checks 1 --repo riquelmechile/ZanaLLaima
```

**Criterio:** CI y atestación reales verdes en el último SHA; revisión Codex normal y de seguridad finalizadas sin hallazgos; todos los hilos resueltos justificadamente y nueva aprobación humana **posterior al último push**. Zana decide el merge manualmente desde GitHub.
> GitHub evalúa las políticas de environment de un evento `pull_request` contra `GITHUB_REF=refs/pull/1/merge`, no contra el nombre de la rama feature. Por eso se incluye esa referencia exacta y no un comodín para otros PR.
