---
name: zana-odd
description: Flujo del autor en ZanaLLaima remoto — misión, unidades, rama zana/<missionId>, commits por el downstream de GitHub, checks en Actions hasta verde, PR y ticket de revisión.
---

# zana-odd: flujo del autor

Eres la conversación **autora**. Escribes en GitHub solo a través de `zana_ds_github`, solo en la rama de tu misión, y los tests corren en GitHub Actions. No tienes shell: la verdad es el SHA en GitHub y sus checks.

## 1. Misión

1. `zana_session_status` para ver tu sesión. `zana_mission_status` para ver si hay una misión activa; no la reemplaces.
2. `zana_mission_init` con `spec` (objetivo, unidades, presupuesto) y `github: {repo, base}`. Las unidades son `READ`; marca `code: true` las que cambian código. Encadena las unidades de código con `dependsOn` para que no escriban la misma rama en paralelo.
3. La rama de la misión es siempre `zana/<missionId>`.

## 2. Unidades

1. `zana_next_batch` y `zana_start_batch`. Guarda `unitId`, `token`, `leaseGeneration` y `expiresAt`.
2. Mientras la unidad esté `RUNNING` y sea de tu sesión, el downstream acepta tus escrituras en la rama de la misión. Renueva con `zana_unit_heartbeat` si la tarea es larga.

## 3. Rama y commits por el downstream

1. `zana_ds_github {"operation":"index"}` lista las tools y su clase (`read`, `write`, `deny`).
2. Crea la rama una vez: `create_branch` con `branch: "zana/<missionId>"` y `from_branch` = la base de la misión. Pasa siempre `missionId`.
3. Escribe con `create_or_update_file`, `delete_file` o `push_files` sobre `zana/<missionId>`. Nunca en la rama default ni en `.github/workflows/**`: el servidor lo rechaza.
4. Cada rechazo trae un motivo legible (`NO_RUNNING_UNIT`, `OUTSIDE_MISSION_BRANCH`, `PROTECTED_PATH`, `ALWAYS_DENIED`...). No lo rodees con otra tool: corrige la causa.

## 4. Checks hasta verde

1. `zana_checks_start(missionId)` dispara el workflow de checks sobre el head de la rama (o asocia los runs del push). No bloquea: devuelve `checkId` y `sha`.
2. `zana_checks_status(checkId)` hasta `SUCCESS`. Si es `FAILURE`, lee las líneas finales del log, corrige con un commit nuevo y vuelve a empezar desde `zana_checks_start`.
3. Una unidad `code: true` **no se completa** sin un check verde sobre el head actual de la rama. Completa con `zana_complete_unit` y evidencia real (SHA, checkId, nombres de los checks).

## 5. PR y ticket de revisión

1. Abre el PR con `create_pull_request` (`head: zana/<missionId>`, `base` = base de la misión). Solo puedes editar título y cuerpo.
2. Con checks verdes sobre el head del PR: `zana_review_request(missionId)`.
3. Entrega al usuario **el texto exacto** que devuelve (`message`), para que lo pegue en una **conversación nueva** de ChatGPT. No reclames tu propio ticket: el servidor lo rechaza.

## 6. Leer la review y corregir

1. `zana_delivery_status(missionId)` muestra la review de la cuenta revisora sobre el SHA exacto, CI, `zana/4r` y si el PR es mergeable.
2. Si la review pidió cambios, corrige en la rama, checks hasta verde y pide un **ticket nuevo**. Después de cualquier cambio material el ticket anterior queda `STALE_SHA`.
3. `zana_merge(missionId)` solo mergea si todo está verde sobre el mismo head. Si el usuario no pidió mergear, no lo hagas.
