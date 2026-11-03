# RDD de una sola cuenta

Este documento describe el ciclo local de revision en cuatro perspectivas. La cuenta GPT ejecuta el trabajo; el servidor solamente prepara los paquetes y registra sus resultados.

Perspectivas: risk, reliability, resilience, readability.

Los resultados nunca representan por si solos una aprobacion independiente ni autorizan merge o despliegue.

## Modalidades

- `SOLO_SEQUENTIAL`: cuatro revisiones en el mismo contexto, una detrás de otra. El resultado sin bloqueos es `SELF_CHECK_COMPLETE_UNVERIFIED`.
- `NATIVE_PLANNED`: hasta cuatro paquetes en contextos de subagentes nativos distintos, si realmente se dispone de esa función. El resultado sin bloqueos es `NATIVE_4R_REPORTED_UNVERIFIED`.

Ambas modalidades dejan `approved: false`, `independentReviewVerified: false` y `candidateVerifiedByGit: false`. Las capacidades y los identificadores de contexto son informes del anfitrión, no pruebas criptográficas.

## Ciclo de trabajo

La misión debe tener todas las unidades en estado `DONE`. Se congela un SHA de Git de 40 caracteres y se exige evidencia por cada lente. `PASS` con hallazgos BLOCKER, CRITICAL o HIGH se rechaza; `CHANGES` obliga a corregir y revisar de nuevo.

Comandos locales:

```sh
node src/cli.mjs review-open $(git rev-parse HEAD)
node src/cli.mjs review-next
node src/cli.mjs review-start
node src/cli.mjs review-submit <lens> <token> <sha> resultado.json
node src/cli.mjs review-status
node src/cli.mjs review-check $(git rev-parse HEAD)
```

El archivo `resultado.json` contiene `verdict`, `summary`, `evidence`, `findings` y `execution`. Usa `SELF_CONTEXT` en modo secuencial o `NATIVE_SUBAGENT` con un `contextId` distinto por lente en modo nativo. Nunca inventes comprobaciones o identificadores.

Las herramientas locales MCP equivalentes tienen el prefijo `zana_review_`. Un SHA diferente invalida las revisiones anteriores; sus hallazgos quedan en el historial, pero no se reutilizan para aprobar un candidato nuevo. Tampoco se cambian permisos, archivos, ramas ni despliegues desde el motor de revisión.
