# MCP v2: integración local y contrato del anfitrión

## Propósito y estado

Esta implementación reemplaza el transporte MCP `stdio` construido manualmente por el **SDK oficial TypeScript v2**, fijado en `@modelcontextprotocol/server@2.4.0`. Usa `@modelcontextprotocol/client@2.4.0` en las pruebas y `zod@4.6.7` para definir y validar los argumentos. La interfaz sigue siendo **local, sin HTTP, sin servidor remoto y sin llamadas a proveedores de inferencia**.

El SDK soporta la especificación MCP 2026-07-28 y negociación con clientes compatibles con versiones anteriores. El programa expone un catálogo de **24 herramientas**, incluyendo `zana_capability_status`. La instalación real en ChatGPT y los lanzamientos de subagentes **NO** forman parte de esta fase de desarrollo.

Fuentes normativas del SDK:
- https://ts.sdk.modelcontextprotocol.io/v2/
- https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html
- https://ts.sdk.modelcontextprotocol.io/v2/servers/logging-progress-cancellation.html

## Uso local

Instalar dependencias en un entorno controlado:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
node src/mcp.mjs
```

El servidor utiliza exclusivamente la entrada/salida estándar del proceso. **stdout** es el canal de protocolo; los diagnósticos solo van a **stderr**. Un host MCP local puede lanzar `node /ruta/absoluta/ZanaLLaima/src/mcp.mjs`. No configurar un callback HTTP inventado ni un endpoint de suscripción.

Las rutas para revisión Git y almacenamiento deben ser locales y restringidas al entorno de trabajo:
`ZANA_STATE_FILE`, `ZANA_REVIEW_REPO` y `ZANA_REVIEW_TARGET_REF`. Los permisos WRITE requieren la clave pública del operador y las restricciones descritas en `safety-lifecycle.md`. **No entregar la clave privada ni secretos al proceso MCP o a un agente.**

La especificación MCP y la configuración del cliente no conceden permisos de escritura. El controlador sigue exigiendo autorización independiente al reservar, comprobar y completar trabajos; el enforcement en el *ejecutor real* del anfitrión permanece como un bloqueo de integración.

## Contrato de capacidades

`zana_capability_status` devuelve tres niveles **no intercambiables**:

- `requested`: requisitos solicitados (modelo, esfuerzo, límites y ausencia de fallback deliberado). No demuestra selección efectiva.
- `hostReported`: modelo, esfuerzo y capacidad de subagentes tal como los declara el cliente. Su procedencia es `HOST_REPORTED_UNVERIFIED` o `NOT_REPORTED`.
- `verified`: modelo, esfuerzo, ejecuciones y evidencias que realmente se verificaron mediante una fuente independiente y autenticada. Por ahora se mantienen en `null` y `NOT_OBSERVED`: una cadena declarada por el cliente no puede llenarlos.

`decision` expone un **plan** de ejecución limitado a cuatro trabajos independientes. Un informe no puede ampliar permisos, firmar una decisión del operador, certificar un subagente o promover un resultado de RDD a revisión independiente. La futura verificación real debe permanecer en una capa de atestación diferente, no en `hostReport`.

## Operaciones, validación y cancelación

Las herramientas usan esquemas Zod estrictos. Un argumento inválido, una operación rechazada por el motor o un recurso ausente produce una respuesta de herramienta `isError: true`, en vez de convertir un fallo recuperable en error general de JSON-RPC. El SDK gestiona `initialize`, negociación, `notifications/initialized`, solicitudes, `tools/list`, `ping` y `notifications/cancelled`.

El manejador consulta `ctx.mcpReq.signal.aborted` antes de despachar. **La cancelación es cooperativa**, no una reversión de efectos ya confirmados: después de abortar o perder una conexión, el cliente debe leer el estado durable antes de reintentar. Si una escritura queda incierta, mantener `OUTCOME_UNKNOWN` y exigir reconciliación firmada. No asignar `success:true` por el hecho de recibir una respuesta.

## E2E local sin subagentes (ZL-019)

`tests/sdk-mcp.test.mjs` inicia un proceso local real `stdio` mediante el cliente oficial. Verifica negociación, descubrimiento del catálogo, validación de argumentos, tratamiento de errores, frontera de capacidades y una misión **READ** completa. Crea un repositorio Git temporal, revisa su SHA verificado y completa los cuatro lentes secuencialmente. Debe terminar en `SELF_CHECK_COMPLETE_UNVERIFIED`, `independentReviewVerified:false` y `approved:false`. Los resultados de la prueba son pruebas de integración del **controlador**, no revisiones de código independientes realizadas por un modelo.

No existe todavía una prueba de una cuenta ChatGPT real, ni evidencia de modelo/esfuerzo real, ni subagentes nativos lanzados. Estos criterios corresponden a **ZL-018** y siguen abiertos por decisión del operador.

## Frontera remota (ZL-020)

No hay listener TCP, HTTP, SSE ni URL de callback. La exposición remota no es una extensión automática del transporte local. Antes de habilitarla se deberá diseñar y comprobar: autenticación OAuth, audiencia/resource, permisos por misión, aislamiento del estado, protección Origin/CSRF, cuotas, tamaño de peticiones, trazabilidad e invalidación de credenciales. Toda integración con ChatGPT se pospone hasta completar las fases de código y revisar estos controles.

## Limitaciones y siguientes gates

- Los contextos nativos y el modelo efectivo permanecen sin verificar.
- La reconexión y cancelación MCP no sustituyen leases, recibos y reconciliación de operaciones WRITE.
- El SDK y sus dependencias transitivas están fijados en `package-lock.json` v3; CI utiliza `npm ci --ignore-scripts`, un preflight estático y auditoría de dependencias de producción. El estado de release sigue bloqueado por requisitos externos de GitHub y del anfitrión.
- La interfaz local no puede impedir ediciones directas realizadas por herramientas externas que no pasen por el controlador.
- Sin merge, deploy o habilitación HTTP hasta pasar gates de seguridad y revisión independiente.

## Herramienta `zana_apply_write` (ZL-004)

Entradas: `unitId`, `token`, `leaseGeneration`, `path` relativo y uno de `content` (texto UTF-8) o `deleteFile:true`. `expectedPreSha256` permite rechazar preimágenes inesperadas. La ejecución revalida el permiso Ed25519, lease, paths autorizados y cuota. Primero persiste una intención `OUTCOME_UNKNOWN`, luego aplica el efecto anclado a directorios Linux y confirma un recibo `preSha256/postSha256` en SQLite. Un fallo posterior a intención requiere conciliación firmada; **nunca volver a llamar automáticamente**.

La herramienta no garantiza que otras capacidades del host hayan sido deshabilitadas. Hay que ejecutar el agente con workspace read-only y otorgar escritura exclusivamente al proceso MCP, mediante SO o contenedor. Ver [seguridad y ciclo de vida](safety-lifecycle.md).

## Emisor de atestación CI (workflow_run, main-only)

**Versión del proyecto: ZanaLLaima 0.5.1.** El sobre Ed25519 `CI_RESULT` es producido por `scripts/ci-attest.mjs`, ejecutado por `.github/workflows/ci-attestation.yml` mediante `workflow_run` una vez que concluye `CI`. El script confiable se carga exclusivamente desde `main` (policy **main-only**) y consulta la API de GitHub para verificar los jobs, SHA, árbol, base, runId y conclusión. Jamás se ejecuta código o dependencias del HEAD del PR con `ZANA_CI_SIGNING_KEY`.

El environment `ci-attestation` exige un reviewer requerido `sebastianriquelme95-max`, que pertenece al mismo dueño del autor; la separación de cuentas no constituye independencia organizacional. La configuración debe impedir self-review y mantener solo `main` como deployment policy. El workflow permanece desactivado hasta configurar el secreto, la llave pública real y `ZANA_CI_ATTESTATION_READY=true` con controles humanos. La llave `keys/ci-verifier.pub` sigue siendo placeholder hasta entonces.

Para verificar el run firmado se usa `gh run list --workflow ci-attestation.yml`, `gh run view` y la descarga del artifact firmado. Ningún sobre CI sustituye la aprobación separada del operador ni autoriza merge o despliegue. Ver [operator-checklist.md](operator-checklist.md) y [release-security.md](release-security.md).
