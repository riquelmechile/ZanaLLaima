# Fase 4: planificador incremental, límites y rendimiento

La Fase 4 implementa un **planificador local de cupos READ** con presupuesto persistente por misión, acceso transaccional SQLite y exclusión estricta de WRITE. **No lanza modelos ni subagentes nativos**: prepara paquetes para las herramientas reales del anfitrión, una vez conectado.

## Planificación incremental (ZL-021)

Al iniciar el planificador evalúa las dependencias del DAG y los estados de las unidades. Si tres lecturas siguen RUNNING y se liberó uno de cuatro cupos, un nuevo \`zana_start_batch\` puede reservar otra lectura independiente **sin esperar la barrera de la tanda anterior**. Esta reserva usa \`BEGIN IMMEDIATE\`, token/generación únicos y actualiza el estado en SQLite.

Los cupos quedan limitados por \`min(hostReport.nativeSubagents.maxConcurrent, mission.budget.maxActiveReads, 4)\`. Si el anfitrión reduce su capacidad a uno y hay dos lecturas en marcha, las reservas adicionales quedan en WAITING hasta que se liberen cupos; no se cancela ni relanza trabajo por una reducción de capacidad.

Un informe de capacidad procede del cliente y sigue siendo \`HOST_REPORTED_UNVERIFIED\`. El controlador **no afirma que se hayan lanzado subagentes**. Si no existe una superficie de subagentes real, solo hay un cupo inline. Las escrituras no se consideran tareas independientes de lectura.

## Aislamiento de efectos WRITE (ZL-022)

- En el repositorio existe un único escritor a la vez, sin excepción por rutas disjuntas.
- Con WRITE en RUNNING, cualquier petición de iniciar otro READ o WRITE devuelve WAITING.
- Si hay un WRITE autorizado y listo pero READ activos, se espera a que terminen las lecturas antes de aceptar otra. Esto evita starvation del escritor.
- Si existe \`OUTCOME_UNKNOWN\`, no se emite ningún trabajo nuevo hasta reconciliación firmada del operador. No asumir que una escritura interrumpida no se ejecutó.
- SQLite rechaza una transacción que intente guardar dos escritores activos o un escritor mezclado con lectores activos.
- Una propuesta de misión no equivale a permiso WRITE; se exige la autorización Ed25519 de fase 0.

No se habilitan escritores paralelos por tener rutas diferentes. Antes de permitirlos habrá que demostrar **worktrees realmente aislados, permisos diferenciados y enforcement en el instante de escritura**, con tests de conflicto y protección contra cambios de symlink/TOCTOU. Esa integración depende del ejecutor anfitrión (ZL-004), aún no probado.

## Presupuestos de misión (ZL-024)

\`src/budget.mjs\` crea y valida un presupuesto inmutable con valores por defecto y máximos absolutos. La misión recibe \`deadlineAt\` al crearse; SQLite \`user_version=4\` almacena el mismo presupuesto y contador de intentos tras reinicios.

| Límite | Por defecto | Máximo configurable |
| --- | ---: | ---: |
| \`maxActiveReads\` | 4 | 4 |
| \`maxUnitAttempts\` | 3 | 3 |
| \`maxWorkStarts\` | 300 | 300 |
| \`maxLeaseSeconds\` | 300 s | 3600 s |
| \`maxResultBytes\` | 16 384 bytes | 65 536 bytes |
| \`maxReviewRounds\` | 5 | 5 |
| \`maxMissionSeconds\` | 86 400 s (24 h) | 604 800 s (7 días) |

La suma de intentos incluye reintentos después de fallos; el límite se consume al **reservar**, no al recibir el resultado. No se permite una misión cuyo presupuesto total sea menor que su número inicial de unidades. Las lecturas fallidas solo pueden reiniciarse dentro del límite. Los WRITE inciertos nunca se reintentan automáticamente; al agotarse los intentos, la reconciliación de “sin efecto” produce un fallo terminal con evidencia del operador en vez de dejar un bucle infinito.

El tamaño de resultados se mide en **bytes UTF-8 de JSON**, no en caracteres, tanto para unidades como para lentes RDD. Las rondas RDD verificadas también están acotadas. El tiempo de misión deja de admitir nuevas reservas al agotarse, y ningún lease nuevo puede superar el deadline. Los paquetes ya reclamados conservan sus tokens; la recuperación y la cancelación siguen su política.

Ejemplo, dentro de una misión:

\`\`\`json
{
  "objective": "Inspeccionar una base de código con límites",
  "authorization": {"writesAllowed": false, "allowedPaths": []},
  "budget": {
    "maxActiveReads": 2,
    "maxUnitAttempts": 2,
    "maxWorkStarts": 12,
    "maxLeaseSeconds": 120,
    "maxResultBytes": 4096,
    "maxReviewRounds": 2,
    "maxMissionSeconds": 3600
  },
  "units": [
    {"id": "scan-a", "effect": "READ", "instruction": "Inspeccionar el módulo A"},
    {"id": "scan-b", "effect": "READ", "instruction": "Inspeccionar el módulo B"}
  ]
}
\`\`\`

\`zana_mission_status\` informa \`budget.limits\`, intentos usados/restantes, lecturas/escrituras activas y vencimiento. \`zana_start_batch\` y el comando CLI \`start [host.json] [leaseSeconds]\` aceptan duración de lease sin superar el presupuesto firmado por la misión. Una reducción de límites después de crear la misión se rechaza como mutación de estado: cambiar presupuestos requiere otra misión.

Las bases v3 se migran a v4 con una transacción de escritura bajo control del operador, sin sobrescribir el historial. Las misiones históricas carecen de deadline retroactivo para no perder trabajo antiguo por una migración.

## Benchmarks reproducibles (ZL-023)

\`\`\`sh
npm ci --ignore-scripts --no-audit --no-fund
npm run benchmark:phase4
npm test
npm run test:stress
npm run test:coverage
\`\`\`

\`scripts/benchmark-phase4.mjs\` crea una base temporal, ejecuta reclamaciones y completados READ mediante transacciones reales SQLite, y mide las latencias p50/p95 de escritura, lectura, historial y recuperación. Registra también tamaño físico de la base, eventos, recibos, unidades completadas y operaciones por segundo, todo en JSON.

Incluye un **modelo determinista de duración de tareas** que compara la antigua barrera completa con la reposición incremental. El cociente de tiempo lógico puede reproducirse en cualquier equipo; **no es una aceleración medida de modelos ni de subagentes**. Las latencias reales de SQLite dependen del runner. No se inventan resultados de agentes.

La suite \`tests/phase4-scheduler.test.mjs\` y \`tests/phase4-benchmark.test.mjs\` cubre:

- Reposición de un cupo con otros lectores aún activos, incluidas capacidades reducidas.
- Drenaje de lectores antes de WRITE, autorización, writer único y rechazo de snapshots falsificados.
- Validación de todos los campos, intentos, deadline, bytes UTF-8, leases y rondas RDD.
- Reapertura de SQLite, persistencia del presupuesto y rollback ante mutación de presupuesto o solapamiento WRITE/READ.
- Benchmarks con recibos únicos y recuperación de lease expirado.

**Gate local:** suite verde con benchmarks registrando mediciones de SQLite y mejora del modelo lógico de planificación, sin alterar exclusividad ni permisos.

**Gate de integración pendiente:** comparar throughput real cuando ChatGPT efectivamente lance contextos nativos, observar capacidad efectiva y aplicar ZL-004 al ejecutor real. Ningún benchmark sintético se presenta como evidencia de un modelo en producción.
