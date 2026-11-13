# Plantilla del workflow de checks para repos administrados

Los tests que cuentan corren en GitHub Actions. Cada repo donde se abran misiones (los que cubre `ZANA_GITHUB_REPOS`, por nombre o con `owner/*`) necesita un workflow `workflow_dispatch`. Por defecto se llama como `ZANA_CHECKS_WORKFLOW` (`zana-checks.yml`), salvo que el operador configure un override explícito por repositorio mediante `ZANA_REPO_CHECKS_JSON`. Con eso basta: `zana_checks_start` lo dispara **una vez por SHA**, cuando la autora terminó de escribir. Así una misión gasta una corrida, y no una por cada push.

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

Adaptar los pasos al lenguaje del repo. El nombre de un required check es el nombre del *check run* (el `name` del job, aquí `test`), no el nombre del workflow. **No configures ese job como required status check:** los checks de `workflow_dispatch` no cuentan para la protección del PR. Exige `zana/4r`: `zana_review_finalize` lo publica en `success` solo con APPROVE y en `failure` con REQUEST_CHANGES, después de exigir CI verde sobre ese SHA.

`zana/4r` es una segunda llave contra merges accidentales, no una prueba de identidad: GitHub no verifica quién publicó el estado. Una identidad con Write, un workflow con `statuses: write` o el token de acceso completo podría publicar `success`; además, el éxito de un ticket reemplazado permanece en el SHA y esta protección no exige CI por sí sola. La garantía fuerte está en `zana_merge` y `zana_delivery_status`, que verifican CI sobre el SHA exacto y que la review y el estado sean de `ZANA_REVIEWER_LOGIN`. Fusionar fuera de `zana_merge` no tiene esa red. Mantén también una aprobación obligatoria.

Reglas:

- El job debe producir check runs sobre el SHA del commit (`zana_checks_status` lee `GET /commits/{sha}/check-runs`).
- Si se configura `ZANA_REQUIRED_CHECKS`, esos nombres deben existir; si no, cuentan todos los check runs del SHA. En overrides por repo, `requiredChecks` es obligatorio y no vacío.
- Sin secretos en el workflow; `permissions: contents: read`.
- **Costo.** En un repo privado cada corrida se paga. No agregues `push` ni `pull_request` a este workflow: con `push` corre en cada commit de la rama, y con `pull_request` corre otra vez sobre el mismo SHA.
- **Si el repo ya tiene su propio CI en `pull_request`**, sáltalo en las ramas de ZanaLLaima con `if: ${{ !startsWith(github.head_ref, 'zana/') }}` en el job (un job saltado no se cobra). Para ZanaLLaima un check saltado no prueba nada: un SHA que solo tiene checks saltados queda `PENDING` hasta que corra el workflow de checks. Tres cosas a saber:
  - GitHub cuenta un check requerido saltado como aprobado. Lo que exige la corrida real es ZanaLLaima, que pide al menos un check exitoso sobre el SHA; un PR `zana/**` aprobado a mano por fuera de ZanaLLaima no tiene esa red.
  - Si en las ramas `zana/**` corren otros workflows (lint, CodeQL), su éxito también cuenta como "un check exitoso". Para que solo valga el de checks, pon el nombre de su job en `ZANA_REQUIRED_CHECKS`. En la configuración global es una sola lista; con `ZANA_REPO_CHECKS_JSON` cada repo puede exigir sus propios jobs.
  - La protección con `zana/4r` también alcanza los PR que no son de ZanaLLaima, pero estos no pueden obtener un ticket 4R porque no son PR de una misión. Quedan bloqueados salvo que el operador use un ruleset o bypass separado, o fusione por su cuenta asumiendo el riesgo; no intentes satisfacer la protección con el nombre del job de `zana-checks`.
- `zana_checks_start` dispara `workflow_dispatch` sobre la rama de la misión solo si ese SHA no tiene ya un run de este workflow. El run disparado corre sobre el head de la rama en ese momento; el estado siempre se lee por SHA exacto.


## CI específico por repositorio (opcional)

En el entorno **del servidor** (no en el código ni en herramientas del modelo):

~~~sh
ZANA_REPO_CHECKS_JSON='{"operador/frontend":{"workflow":"zana-node.yml","requiredChecks":["test","lint"]},"operador/backend":{"workflow":"zana-python.yml","requiredChecks":["pytest"]}}'
~~~

Ambos repositorios deben estar cubiertos por `ZANA_GITHUB_REPOS` (por nombre o con `owner/*`) y tener sus workflows instalados previamente por el operador. Los nombres de workflow son archivos, no rutas, y cada entrada debe contener exactamente `workflow` y `requiredChecks` (1 a 20 nombres distintos). Errores o repositorios desconocidos impiden iniciar el servidor. En ausencia de la variable, se mantiene el comportamiento global anterior.

`zana_checks_start` utiliza el workflow definido para el repositorio de la misión y `zana_checks_status` verifica los jobs correspondientes sobre el SHA exacto. Un cambio de nombre de workflow después del dispatch invalida ese checkId y exige iniciar otro. La configuración no otorga acceso a nuevos repositorios, no instala CI y no permite escribir `.github/workflows/**`.
