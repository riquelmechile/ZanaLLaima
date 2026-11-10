# E2E real del modo remoto (ZL-018)

**La corre el operador después del deploy** (`docs/deploy-remote.md`). Ningún resultado de esta guía se puede afirmar desde los tests locales: los tests usan un MCP y una API de GitHub falsos. El reporte va en `examples/host-e2e-remote.json` y lleva `assurance: OPERATOR_OBSERVED` **solo** con links al PR, a la review, a los check runs y el extracto de auditoría.

**Resultado registrado (9 nov 2026):** el camino feliz y una ronda de corrección se observaron sobre un deploy real; los casos negativos de la sección 3 todavía no se corrieron en vivo. Por eso `examples/host-e2e-remote.json` dice `PARTIALLY_OBSERVED`: un valor intermedio para cuando falta alguna sección. Ese reporte tampoco trae ids de sesión, links ni extracto de auditoría, porque el repo es público y esos valores quedan en el servidor del operador.

## 0. Preparación

1. Repo sandbox, por ejemplo `<owner>/zanallaima-sandbox`, en `ZANA_GITHUB_REPOS`, con `main` protegida (checks y review requeridos) y el workflow de `docs/checks-workflow.md`.
2. Conector ZanaLLaima agregado en la app de ChatGPT (paso 7 de `docs/deploy-remote.md`).

## 1. Conversación A (autora)

Abrir una conversación nueva y pedir: "Con ZanaLLaima, crea una misión en <owner>/zanallaima-sandbox para agregar una función `sum(a,b)` con su test".

Registrar:
- `zana_session_status` → `session.id` y `session.createdAt` de A.
- La misión (`missionId`), la rama `zana/<missionId>`, los commits por `zana_ds_github`, `zana_checks_start`/`zana_checks_status` hasta `SUCCESS`, el PR y la respuesta de `zana_review_request` (ticket y hora). Orden esperado: con la unidad `RUNNING` (heartbeat con `leaseSeconds` = `maxLeaseSeconds`) los commits, el PR y los checks; con checks verdes, `zana_complete_unit`; recién después `zana_review_request`. Con una unidad de código `RUNNING`, `zana_review_request` responde `UNIT_STILL_RUNNING`.

## 2. Conversación B (nueva)

Abrir **otra conversación nueva** y pegar exactamente el mensaje del ticket ("Revisa el ticket ZR-... con ZanaLLaima"). Su primera tool debe ser `zana_review_claim`.

Registrar:
- `zana_session_status` de B: `session.id` **debe ser distinto** del de A y `createdAt` posterior al ticket. Anotar en `sessionSeparationObserved` lo que se vio (por ejemplo, si al reabrir A apareció otra sesión).
- `zana_review_claim` aceptado, las páginas leídas con `zana_review_diff`, los 4 lentes (`execution` declarado) y `zana_review_finalize`.
- En GitHub: la review firmada por la cuenta revisora (`ZANA_REVIEWER_LOGIN`) sobre el SHA, y el status `zana/4r`.
- Si se usa `ZANA_DISTINCT_REVIEWER_CLIENT=true`, B debe usar otro cliente OAuth registrado que todos los que actuaron en la misión; con el mismo cliente el claim da `SAME_CLIENT`. Que sea otra cuenta de ChatGPT depende de que el operador solo haya dado de alta cuentas distintas.

## 3. Casos negativos en vivo (códigos reales)

| Caso | Cómo | Código esperado |
| --- | --- | --- |
| B intenta escribir | En B, pedir que escriba un archivo en la rama de la misión | `REVIEWER_READ_ONLY` |
| A reclama su ticket | En A, después de pedir un ticket, pedir que lo reclame A misma | `AUTHOR_SESSION` |
| Ticket con la unidad RUNNING | En A, con la unidad de código todavía RUNNING y checks verdes, pedir `zana_review_request` | `UNIT_STILL_RUNNING` |
| Push después del ticket | Con la unidad completa: en A pedir un ticket; en una conversación C nueva reclamarlo, leer todas las páginas del diff y enviar los 4 lentes. A ya no puede escribir (`NO_RUNNING_UNIT`), así que el operador hace un commit en `zana/<missionId>` con su cuenta (web de GitHub o git); luego finalizar en C | `zana_review_finalize` en C responde `state: STALE_SHA`, `published: false` (sin review ni `zana/4r` en GitHub). Para seguir, con checks verdes sobre el head nuevo, A pide un ticket nuevo sobre ese head (`zana_correction_start` no aplica: no hubo REQUEST_CHANGES) |
| Merge por el downstream | En A, pedir `merge_pull_request` por `zana_ds_github` | `ALWAYS_DENIED` |
| Escribir en `main` | En A, con su unidad RUNNING (antes de completarla, o con la unidad de `zana_correction_start`), pedir `create_or_update_file` con `branch: main` | `OUTSIDE_MISSION_BRANCH` (sin unidad RUNNING de la sesión, el primer rechazo es `NO_RUNNING_UNIT`) |

Para cada caso, copiar el id de la fila de auditoría: `node src/cli.mjs remote-audit 100 <missionId> --env-file <env del servidor>`.

## 4. Reporte

Completar `examples/host-e2e-remote.json` con los links y el extracto de auditoría (ids, tool, outcome, sesión; nunca tokens). Commitear el reporte en una rama y pedir revisión. Si la separación de sesiones no se observó, dejarlo escrito y mantener `assurance: NOT_OBSERVED`.
