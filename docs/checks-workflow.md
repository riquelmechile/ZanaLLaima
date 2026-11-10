# Plantilla del workflow de checks para repos administrados

Los tests que cuentan corren en GitHub Actions. Cada repo de `ZANA_GITHUB_REPOS` necesita un workflow llamado como `ZANA_CHECKS_WORKFLOW` (por defecto `zana-checks.yml`) que se pueda disparar con `workflow_dispatch`. Con eso basta: `zana_checks_start` lo dispara **una vez por SHA**, cuando la autora terminó de escribir. Así una misión gasta una corrida, y no una por cada push.

**Lo agrega el operador.** ZanaLLaima nunca escribe en `.github/workflows/**` de otro repo (la política lo deniega) y esta plantilla no se instala sola.

```yaml
name: zana-checks
on:
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
- **Costo.** En un repo privado cada corrida se paga. No agregues `push` ni `pull_request` a este workflow: con `push` corre en cada commit de la rama, y con `pull_request` corre otra vez sobre el mismo SHA.
- **Si el repo ya tiene su propio CI en `pull_request`**, sáltalo en las ramas de ZanaLLaima con `if: ${{ !startsWith(github.head_ref, 'zana/') }}` en el job (un job saltado no se cobra y `zana_checks_status` lo cuenta como neutro). Ojo: GitHub cuenta un check requerido saltado como aprobado; lo que exige la corrida real es ZanaLLaima, que pide al menos un check exitoso sobre el SHA.
- `zana_checks_start` dispara `workflow_dispatch` sobre la rama de la misión solo si ese SHA no tiene ya un run de este workflow. El run disparado corre sobre el head de la rama en ese momento; el estado siempre se lee por SHA exacto.
