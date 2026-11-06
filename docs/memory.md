# Memoria por proyecto

ZanaLLaima recuerda, por repositorio, lo que un próximo desarrollador necesita saber: convenciones, decisiones, pendientes, problemas conocidos y el resumen de cada misión cerrada. La memoria vive en el servidor (el mismo SQLite de `ZANA_STATE_FILE`, ver [almacenamiento](sqlite-storage.md)); no se commitea, no sale en los PR y solo se lee a través del OAuth del conector.

## El archivo `.zanallaima.json`

En la raíz de la rama base de un repo administrado puede haber un archivo como este:

```json
{"zanallaima":1,"projectId":"zp_3f9c2a7e1b4d8c05","githubRepoId":123456789,"note":"Antes de trabajar en este repositorio, pide zana_memory_context con este projectId a ZanaLLaima."}
```

**Para personas:** es un puntero, no un secreto. No trae URL, cuentas ni datos del operador (`githubRepoId` es el id público del repo, el mismo que entrega la API de GitHub); el `projectId` no sirve sin una conexión OAuth aprobada en el servidor. El repo puede ser público. No lo edites a mano: si cambia, ZanaLLaima lo detecta y pide reescribirlo. Si lo borras, se vuelve a escribir en la próxima misión.

**Para otros agentes:** si trabajas en este repo y tienes el conector de ZanaLLaima, llama a `zana_memory_context` con ese `projectId` antes de planificar y respeta lo que diga. Si no tienes el conector, ignora el archivo: no contiene instrucciones ni datos del proyecto.

## Cómo se identifica un proyecto

Un proyecto es un repo de GitHub identificado por su **id numérico** (`GET /repos/{owner}/{repo}` → `id`), no por su nombre: sobrevive renombres y transferencias. En cada `zana_mission_init` el servidor lee el id del repo y el puntero de la rama base, y responde `memory.pointer.status`:

| Estado | Qué pasó | Qué hace el servidor |
| --- | --- | --- |
| `OK` | El puntero es de este repo, o es un id que el servidor no conoce, su `githubRepoId` es el de este repo y el repo no tiene proyecto (base restaurada u otro servidor) | Usa ese proyecto (en el segundo caso adopta el id) |
| `POINTER_MISSING` | No hay puntero o no se puede leer | Usa el proyecto del repo o crea uno |
| `POINTER_STALE` | El id no existe y el repo ya tiene otro proyecto, o el puntero no trae `githubRepoId` | Usa el proyecto del repo o crea uno |
| `POINTER_FOREIGN` | El id o el `githubRepoId` son de **otro** repo (copia o fork), aunque el fork llegue antes que el original | Usa o crea el proyecto propio de este repo: las misiones de la copia nunca escriben ni mezclan la memoria del original |

Si el estado no es `OK`, la conversación autora escribe `memory.pointer.content` como **primer archivo** de la rama de la misión. Ese archivo no cuenta en el presupuesto de líneas del PR. Si GitHub no responde, la misión se crea igual con `memory.error`: la memoria nunca bloquea el trabajo, y el proyecto se resuelve al guardar o al cerrar.

## Qué se guarda y cuándo

- **Al empezar:** `zana_mission_init` trae `memory.context` (hasta 4 KB): convenciones y decisiones vivas, pendientes sin resolver, issues y los últimos 3 resúmenes, en ese orden; `truncated: true` si se cortó. `zana_memory_context` da el mismo bloque con 16 KB, por `projectId`, por `missionId` o de la misión activa.
- **Durante el trabajo:** `zana_memory_save` (`decision`, `convention`, `issue`, `pending`) con un `topic` corto y estable; el mismo `kind` y `topic` reemplaza la entrada anterior, que queda marcada como supersedida. `zana_memory_resolve` cierra un `pending`. Las puede usar cualquier sesión con la misión activa menos la revisora, que recibe `REVIEWER_READ_ONLY`.
- **Al cerrar:** `zana_mission_close` exige `summary` (`done`, `decisions`, `conventions`, `pending`, `keyFiles`) y lo guarda en la misma transacción del cierre. Sin él responde `SUMMARY_REQUIRED`. El `close` del CLI del operador no pide resumen: es la vía de emergencia.
- **Para buscar:** `zana_memory_search` busca palabras en el proyecto actual (o `projectId`), o en todos con `all: true`. Primero las entradas vivas; las reemplazadas vienen con `superseded: true`.

Todo `topic` (hasta 80 caracteres) y `body` (hasta 1000) pasa por la redacción de tokens antes de guardarse: los secretos del entorno del servidor, tokens de GitHub, `Bearer` y formas comunes de credencial (`sk-…`, `AKIA…`, `xox…`, llaves PEM). Otras formas no se reconocen: no guardes secretos en la memoria. Nada se borra por antigüedad; las tablas viajan en el backup del SQLite.

## Lecturas y memoria general

`zana_memory_context` y `zana_memory_search` aceptan cualquier `projectId`, y `all: true` busca en todos los proyectos. Es deliberado: la base es la memoria general del operador, y en una instancia de un solo operador sus conversaciones pueden leer la memoria de cualquiera de sus proyectos. Las escrituras (`zana_mission_close`, `zana_memory_save`, `zana_memory_resolve`) van siempre al proyecto de la misión activa.
