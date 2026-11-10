# Downstream GitHub MCP y política de ZanaLLaima

ZanaLLaima monta el **GitHub MCP oficial** (`https://api.githubcopilot.com/mcp/`, toolsets `context,repos,pull_requests,git,actions` enviados en la cabecera `X-MCP-Toolsets`) detrás de un gateway copiado de Panter-ai (`src/downstream.mjs`, procedencia `panter-ai@1a99048`, `src/core/downstream.ts` y `docs/DOWNSTREAM_MCP.md`). El host lo usa con un solo router:

```
zana_ds_github { "operation": "index" }
zana_ds_github { "operation": "index", "arguments": { "operation": "push_files" } }
zana_ds_github { "operation": "get_file_contents", "arguments": { "owner": "o", "repo": "r", "path": "README.md" } }
zana_ds_github { "operation": "push_files", "missionId": "<id>", "arguments": { "owner": "o", "repo": "r", "branch": "zana/<id>", "files": [ ... ], "message": "..." } }
```

## Gateway (contrato heredado de Panter)

- Clases desde las anotaciones del downstream: `readOnlyHint:true` es **read**; `destructiveHint:false` es **write**; cualquier otra cosa es **destructive**.
- `writes: deny | grant | allow`. GitHub se monta con `grant`: la "grant" es la política de ZanaLLaima de abajo, evaluada en cada llamada.
- La lista de tools se vuelve a leer si tiene más de 60 s; si falla, la llamada falla (fail closed) y durante 10 s se falla rápido.
- Timeout por llamada (`ZANA_DOWNSTREAM_TIMEOUT_MS`, 30 s por defecto), circuit breaker (3 fallos de conexión, 30 s abierto), sin redirecciones y respuestas acotadas (4 MB por respuesta, 2 MB por resultado).
- Cada llamada lleva una aserción de actor firmada Ed25519 (`_meta["zana-llaima/actor"]`, `src/actor-assertion.mjs`) con host, sesión, misión, tool y digest de los argumentos. La llave pública está en `/.well-known/zana-downstream-keys`. El GitHub MCP oficial no la verifica; queda para downstreams propios.
- Auditoría por llamada: host, sesión, tool, misión, clase, resultado, duración y **HMAC de los argumentos** (llave en la DB, nunca los argumentos).
- El token (`ZANA_DOWNSTREAM_GITHUB_TOKEN`) solo viaja en la cabecera `Authorization` hacia la URL configurada. Se redacta de resultados, errores y auditoría.

## Política de GitHub de ZanaLLaima (`src/github-policy.mjs`)

Allowlist y fail closed sobre la lista real de tools (`data/github-mcp-tools.json`):

- **Lectura:** siempre permitida, a cualquier sesión.
- **Escritura:** solo con `missionId` de la misión activa remota, desde una sesión que tiene una unidad `RUNNING` de esa misión, que **no** reclamó un ticket de revisión de ella, en el repo de la misión, y:
  - `create_branch`: `branch` = `zana/<missionId>` y `from_branch` = base de la misión;
  - `create_or_update_file`, `delete_file`, `push_files`: `branch` = `zana/<missionId>`, rutas relativas sin `..`, nunca `.github/workflows/**` ni `.git/`;
  - `create_pull_request`: `head` = rama de la misión, `base` = base de la misión, solo `title` y `body`; `draft` solo se acepta ausente o en `false` (cualquier otro valor da `DRAFT_NOT_ALLOWED`: la política no permite cambiar el estado de borrador y un borrador no se puede mergear);
  - `update_pull_request`, `update_pull_request_title`, `update_pull_request_body`: solo título y cuerpo del PR abierto desde la rama de la misión hacia su base;
  - `add_reply_to_pull_request_comment`, `add_issue_comment`: solo texto (sin reacciones) en el PR de la misión. `add_issue_comment` es del toolset `issues`, que no viene en `ZANA_DOWNSTREAM_GITHUB_TOOLSETS` por defecto; para comentar la conversación del PR el operador agrega `issues` (las demás tools de issues quedan `UNCLASSIFIED` y denegadas);
  - `actions_run_trigger`: solo `method: run_workflow` del workflow de checks (`ZANA_CHECKS_WORKFLOW`) con `ref` = rama de la misión y sin `inputs`.
  - Además, la rama de la misión no puede ser la rama default del repo.
  - Cada tool permitida acepta **solo las claves exactas de su schema** (`ALLOWED_KEYS` en `src/github-policy.mjs`), sin las que la política no admite: reacciones, revisores, `allow_symlink_write`, `inputs`, `state`, `base` o `draft` al editar. Una clave de más (`Branch`, `Path`, `ref`...) se rechaza con `FIELD_NOT_ALLOWED`.
  - Las rutas no pueden tener `%`, `?`, `#`, barra invertida ni caracteres de control (el downstream podría decodificar `%2e%2e` o `%2F`).
  - `head` del PR se compara exacto con la rama de la misión; solo el prefijo `owner:` es insensible a mayúsculas.
- **Siempre denegado:** merge (solo `zana_merge`), reviews con el token autor, cambios de estado/draft/revisores del PR, actualizar la rama desde la base, crear/borrar/forkear repos, cualquier tool fuera del catálogo y cualquier tool clasificada como lectura que deje de declarar `readOnlyHint` (`CLASSIFICATION_DRIFT`). El catálogo no tiene tools de settings, protección de ramas, secretos, webhooks ni colaboradores con escritura; si aparecen, quedan `UNCLASSIFIED` y se deniegan.
- Cada rechazo devuelve un código y un motivo legible (`NO_RUNNING_UNIT`, `OUTSIDE_MISSION_BRANCH`, `PROTECTED_PATH`, `REVIEWER_READ_ONLY`, `ALWAYS_DENIED`, `UNCLASSIFIED`...) y queda en la auditoría.

`tests/remote-downstream.test.mjs` falla si el catálogo contiene una tool sin clasificar, una escritura sin regla o una lectura sin `readOnlyHint`, y prueba contra un servidor MCP falso cada tool denegada, escrituras fuera de la rama, sin unidad RUNNING, sobre `.github/workflows`, tools nuevas sin clasificar y la redacción del token.

## Lista real de tools (GitHub MCP Server v2.1.0)

Fuente: `github/github-mcp-server` tag `v2.1.0` (commit `4bcdcdf8d7beee98c9448e73e257308280924cc4`). Anotaciones leídas de `pkg/github/__toolsnaps__/<tool>.snap`; toolset y feature flag del código Go de `pkg/github` (la ubicación exacta está en `source` dentro del JSON). El servidor remoto puede exponer un subconjunto o tools nuevas: las nuevas quedan denegadas hasta clasificarlas. `index` muestra los `problems` de la lista viva.

Para actualizar a otra versión: clonar el tag nuevo, comparar sus `__toolsnaps__` y el toolset de cada tool con `data/github-mcp-tools.json`, clasificar cada tool nueva (lectura, escritura con regla o denegada con motivo), subir `version`/`commit` y correr `npm test`.

| Tool | Toolset | Anotaciones upstream | ZanaLLaima | Regla o motivo |
| --- | --- | --- | --- | --- |
| `actions_get` | actions | readOnly | permitida (lectura) |  |
| `actions_list` | actions | readOnly | permitida (lectura) |  |
| `get_job_logs` | actions | readOnly | permitida (lectura) |  |
| `get_me` | context | readOnly | permitida (lectura) |  |
| `get_team_members` | context | readOnly | permitida (lectura) |  |
| `get_teams` | context | readOnly | permitida (lectura) |  |
| `ui_get` | context | readOnly | permitida (lectura) |  |
| `get_repository_tree` | git | readOnly | permitida (lectura) |  |
| `list_pull_requests` | pull_requests | readOnly | permitida (lectura) |  |
| `pull_request_read` | pull_requests | readOnly | permitida (lectura) |  |
| `search_pull_requests` | pull_requests | readOnly | permitida (lectura) |  |
| `get_commit` | repos | readOnly | permitida (lectura) |  |
| `get_file_blame` | repos (flag `file_blame`) | readOnly | permitida (lectura) |  |
| `get_file_contents` | repos | readOnly | permitida (lectura) |  |
| `get_latest_release` | repos | readOnly | permitida (lectura) |  |
| `get_release_by_tag` | repos | readOnly | permitida (lectura) |  |
| `get_tag` | repos | readOnly | permitida (lectura) |  |
| `list_branches` | repos | readOnly | permitida (lectura) |  |
| `list_commits` | repos | readOnly | permitida (lectura) |  |
| `list_releases` | repos | readOnly | permitida (lectura) |  |
| `list_repository_collaborators` | repos | readOnly | permitida (lectura) |  |
| `list_tags` | repos | readOnly | permitida (lectura) |  |
| `search_code` | repos | readOnly | permitida (lectura) |  |
| `search_commits` | repos | readOnly | permitida (lectura) |  |
| `search_repositories` | repos | readOnly | permitida (lectura) |  |
| `actions_run_trigger` | actions | destructive=true | permitida solo en la misión | `checks-dispatch` |
| `add_issue_comment` | issues | destructive=(por defecto true) | permitida solo en la misión | `pr-comment` |
| `add_reply_to_pull_request_comment` | pull_requests | destructive=(por defecto true) | permitida solo en la misión | `pr-reply` |
| `create_pull_request` | pull_requests | destructive=(por defecto true) | permitida solo en la misión | `pr-create` |
| `update_pull_request` | pull_requests | destructive=(por defecto true) | permitida solo en la misión | `pr-edit` |
| `update_pull_request_body` | pull_requests (flag `pull_requests_granular`) | destructive=false | permitida solo en la misión | `pr-body` |
| `update_pull_request_title` | pull_requests (flag `pull_requests_granular`) | destructive=false | permitida solo en la misión | `pr-title` |
| `create_branch` | repos | destructive=(por defecto true) | permitida solo en la misión | `branch` |
| `create_or_update_file` | repos | destructive=(por defecto true) | permitida solo en la misión | `file` |
| `delete_file` | repos | destructive=true | permitida solo en la misión | `file` |
| `push_files` | repos | destructive=(por defecto true) | permitida solo en la misión | `files` |
| `add_comment_to_pending_review` | pull_requests | destructive=(por defecto true) | denegada | Las reviews con el token autor están siempre denegadas |
| `add_pull_request_review_comment` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Los comentarios de review crean una review con el token autor |
| `add_pull_request_review_comment_reaction` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Reacciones no están en la allowlist |
| `create_pull_request_review` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Las reviews con el token autor están siempre denegadas |
| `delete_pending_pull_request_review` | pull_requests (flag `pull_requests_granular`) | destructive=true | denegada | Las reviews con el token autor están siempre denegadas |
| `hide_pull_request_review` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Ocultar reviews no está en la allowlist |
| `hide_pull_request_review_comment` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Ocultar comentarios de review no está en la allowlist |
| `merge_pull_request` | pull_requests | destructive=(por defecto true) | denegada | El merge solo existe vía zana_merge |
| `pull_request_review_write` | pull_requests | destructive=(por defecto true) | denegada | Las reviews con el token autor están siempre denegadas |
| `remove_pull_request_review_comment_reaction` | pull_requests (flag `pull_requests_granular`) | destructive=true | denegada | Reacciones no están en la allowlist |
| `request_pull_request_reviewers` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Pedir revisores no está en la allowlist |
| `resolve_review_thread` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Resolver hilos de review no está en la allowlist |
| `submit_pending_pull_request_review` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Las reviews con el token autor están siempre denegadas |
| `unhide_pull_request_review` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Mostrar reviews no está en la allowlist |
| `unhide_pull_request_review_comment` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Mostrar comentarios de review no está en la allowlist |
| `unresolve_review_thread` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Reabrir hilos de review no está en la allowlist |
| `update_pull_request_branch` | pull_requests | destructive=(por defecto true) | denegada | Actualizar la rama desde la base no está en la allowlist |
| `update_pull_request_draft_state` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | El estado draft no está en la allowlist (solo título y cuerpo) |
| `update_pull_request_state` | pull_requests (flag `pull_requests_granular`) | destructive=false | denegada | Cerrar o reabrir el PR no está en la allowlist |
| `create_repository` | repos | destructive=(por defecto true) | denegada | Crear repositorios no es parte de una misión |
| `delete_repository` | repos | destructive=true | denegada | Borrar repositorios está siempre denegado |
| `fork_repository` | repos | destructive=(por defecto true) | denegada | Forks fuera del repo de la misión |
