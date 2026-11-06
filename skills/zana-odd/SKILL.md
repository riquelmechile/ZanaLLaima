---
name: zana-odd
description: Flujo del autor en ZanaLLaima remoto — misión, rama zana/<missionId>, commits por el downstream de GitHub con la unidad RUNNING, checks en Actions hasta verde, PR, completar la unidad, ticket, corrección y merge.
---

# zana-odd: flujo del autor

Eres la conversación **autora**. Escribes en GitHub solo con `zana_ds_github`, solo en la rama de tu misión y solo mientras tu sesión tiene una unidad `RUNNING`. Los tests corren en GitHub Actions. No tienes shell: la verdad es el SHA en GitHub y sus checks.

## 1. Misión

1. `zana_session_status` y `zana_mission_status`. Si hay una misión activa, no la reemplaces. Si está `CLOSED` o `CANCELLED`, `zana_mission_archive` libera el slot.
2. `zana_mission_init` con `spec` y `github`. Ejemplo exacto:

```json
{"spec":{"objective":"Agregar sum(a,b) con su test","budget":{"maxLeaseSeconds":3600},
  "units":[{"id":"code","effect":"READ","code":true,"instruction":"Implementar sum y su test"}]},
 "github":{"repo":"riquelmechile/zanallaima-sandbox","base":"main"}}
```

   Las unidades son `READ`; `code: true` marca las que cambian código. Encadena las de código con `dependsOn` para no escribir la misma rama en paralelo. La rama es siempre `zana/<missionId>`.

## 2. La unidad de código y su lease

1. `zana_next_batch` y `zana_start_batch` con `leaseSeconds` igual a `maxLeaseSeconds` del presupuesto. Guarda `unitId`, `token`, `leaseGeneration` y `expiresAt`.
2. Mientras escribes, abres el PR y corres checks, renueva con `zana_unit_heartbeat` (también con `leaseSeconds` = `maxLeaseSeconds`) antes de `expiresAt`.
3. Si el lease venció (`EXPIRED`): `zana_recover_expired` → `zana_unit_retry` → `zana_start_batch` (token nuevo; consume un intento).
4. Si el servidor se reinició o tu conversación tiene otra sesión MCP y el lease **sigue vigente**: `zana_session_rebind` (`missionId`, `unitId`, `token`, `leaseGeneration`), sin consumir intento. Con el lease vencido no sirve: usa el paso 3.

## 3. Rama y commits por el downstream

1. `zana_ds_github {"operation":"index"}` lista las tools; mira el campo `zana` (`read`, `write`, `deny`), no `cls`.
2. En cada escritura pasa `missionId` en el nivel superior, al lado de `operation` y `arguments`:

```json
{"operation":"create_branch","missionId":"<missionId>",
 "arguments":{"owner":"riquelmechile","repo":"zanallaima-sandbox","branch":"zana/<missionId>","from_branch":"main"}}
```

3. Escribe con `create_or_update_file`, `delete_file` o `push_files` sobre `zana/<missionId>`. Solo estas claves (cualquier otra da `FIELD_NOT_ALLOWED`, que lista las permitidas):
   - `create_branch`: `owner`, `repo`, `branch`, `from_branch`;
   - `create_or_update_file`: `owner`, `repo`, `path`, `content`, `message`, `branch`, `sha`;
   - `delete_file`: `owner`, `repo`, `path`, `message`, `branch`;
   - `push_files`: `owner`, `repo`, `branch`, `files` (cada uno solo `path` y `content`), `message`;
   - `create_pull_request`: `owner`, `repo`, `title`, `head`, `base`, `body`, `draft`;
   - `update_pull_request`: `owner`, `repo`, `pullNumber`, `title`, `body`;
   - `actions_run_trigger`: `owner`, `repo`, `method: run_workflow`, `workflow_id` (el de checks), `ref`.

   Nada de `.github/workflows/**`, `.git/`, `%`, `?`, `#` ni caracteres de control en las rutas.
4. Cada rechazo trae un código legible. No lo rodees con otra tool: corrige la causa.

## 4. Checks hasta verde

1. `zana_checks_start(missionId)`: no bloquea, devuelve `checkId` y `sha`.
2. `zana_checks_status(checkId)` hasta `SUCCESS`. Con `FAILURE` lee las líneas finales del log, corrige con otro commit y vuelve a `zana_checks_start`. Si responde `partial`, vuelve a consultar.

## 5. PR, completar la unidad y ticket

1. `create_pull_request` con `head: zana/<missionId>` exacto y `base` = base de la misión. Solo puedes editar título y cuerpo.
2. Con checks verdes sobre el head del PR, **completa la unidad**: `zana_complete_unit` con evidencia real (SHA, checkId, checks). Exige check verde sobre el head actual de la rama. Así no hay que mantener el lease vivo mientras el usuario revisa en otra conversación.
3. `zana_review_request(missionId)`: no exige una unidad RUNNING. Cada ticket consume una ronda (`maxReviewRounds`).
4. Entrega al usuario **el texto exacto** del campo `message` para que lo pegue en una **conversación nueva**. No reclames tu propio ticket.

## 6. Review, corrección y entrega

1. `zana_delivery_status(missionId)` muestra la review sobre el SHA exacto, CI, `zana/4r` y si el PR es mergeable.
2. Si pidió cambios: `zana_correction_start(missionId)` agrega una unidad de corrección `PENDING`; `zana_start_batch`, corrige en la rama, checks hasta verde, `zana_complete_unit` y un **ticket nuevo**. Sobre el mismo SHA se rechaza con `CHANGES_REQUESTED_SAME_SHA`, aunque el ticket anterior haya vencido.
3. Con la review aprobada: `zana_merge(missionId)` solo si el usuario lo pide. Nunca `merge_pull_request` por el downstream.
4. Después del merge: `zana_mission_close` y `zana_mission_archive`, para poder iniciar otra misión.
