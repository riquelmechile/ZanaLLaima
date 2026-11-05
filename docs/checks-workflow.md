# Plantilla del workflow de checks para repos administrados

GPT no tiene shell: los tests corren en GitHub Actions. Cada repo de `ZANA_GITHUB_REPOS` necesita un workflow llamado como `ZANA_CHECKS_WORKFLOW` (por defecto `zana-checks.yml`) que corra en cada push a `zana/**` y que se pueda disparar con `workflow_dispatch`.

**Lo agrega el operador.** ZanaLLaima nunca escribe en `.github/workflows/**` de otro repo (la política lo deniega) y esta plantilla no se instala sola.

```yaml
name: zana-checks
on:
  push:
    branches: ['zana/**']
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: zana-checks-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    name: test
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: '22'
      - run: npm ci --ignore-scripts
      - run: npm test
```

Adaptar los pasos al lenguaje del repo. Reglas:

- El job debe producir check runs sobre el SHA del commit (`zana_checks_status` lee `GET /commits/{sha}/check-runs`).
- Si se configura `ZANA_REQUIRED_CHECKS`, esos nombres de check deben existir; si no, cuentan todos los check runs del SHA.
- Sin secretos en el workflow; `permissions: contents: read`.
- `zana_checks_start` dispara `workflow_dispatch` sobre la rama de la misión solo si el push no dejó ya un run para ese SHA. El run disparado corre sobre el head de la rama en ese momento; el estado siempre se lee por SHA exacto.
