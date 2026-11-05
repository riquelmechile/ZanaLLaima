# E2E real del modo remoto (ZL-018)

**La corre el operador después del deploy** (`docs/deploy-remote.md`). Ningún resultado de esta guía se puede afirmar desde los tests locales: los tests usan un MCP y una API de GitHub falsos. El reporte va en `examples/host-e2e-remote.json` y lleva `assurance: OPERATOR_OBSERVED` **solo** con links al PR, a la review, a los check runs y el extracto de auditoría.

## 0. Preparación

1. Repo sandbox, por ejemplo `riquelmechile/zanallaima-sandbox`, en `ZANA_GITHUB_REPOS`, con `main` protegida (checks y review requeridos) y el workflow de `docs/checks-workflow.md`.
2. Conector ZanaLLaima agregado en la app de ChatGPT (paso 5 del deploy).

## 1. Conversación A (autora)

Abrir una conversación nueva y pedir: "Con ZanaLLaima, crea una misión en riquelmechile/zanallaima-sandbox para agregar una función `sum(a,b)` con su test".

Registrar:
- `zana_session_status` → `session.id` y `session.createdAt` de A.
- La misión (`missionId`), la rama `zana/<missionId>`, los commits por `zana_ds_github`, `zana_checks_start`/`zana_checks_status` hasta `SUCCESS`, el PR y la respuesta de `zana_review_request` (ticket y hora).

## 2. Conversación B (nueva)

Abrir **otra conversación nueva** y pegar exactamente el mensaje del ticket ("Revisa el ticket ZR-... con ZanaLLaima").

Registrar:
- `zana_session_status` de B: `session.id` **debe ser distinto** del de A y `createdAt` posterior al ticket. Anotar en `sessionSeparationObserved` lo que se vio (por ejemplo, si al reabrir A apareció otra sesión).
- `zana_review_claim` aceptado, los 4 lentes (`execution` declarado) y `zana_review_finalize`.
- En GitHub: la review firmada por `sebastianriquelme95-max` sobre el SHA, y el status `zana/4r`.

## 3. Casos negativos en vivo

1. En B: pedir que escriba un archivo en la rama de la misión → `REVIEWER_READ_ONLY`.
2. En A: pedir que reclame su propio ticket (pedir antes un ticket nuevo) → `AUTHOR_SESSION`.
3. Pedir un ticket nuevo en A, reclamarlo en una conversación C nueva, hacer un push nuevo desde A y finalizar en C → `STALE_SHA`, sin review publicada.
4. En A: pedir `merge_pull_request` por el downstream o escribir en `main` → `ALWAYS_DENIED` u `OUTSIDE_MISSION_BRANCH`.

Para cada caso, copiar el id de la fila de auditoría: `node src/cli.mjs remote-audit 100 <missionId>`.

## 4. Reporte

Completar `examples/host-e2e-remote.json` con los links y el extracto de auditoría (ids, tool, outcome, sesión; nunca tokens). Commitear el reporte en una rama y pedir revisión. Si la separación de sesiones no se observó, dejarlo escrito y mantener `assurance: NOT_OBSERVED`.
