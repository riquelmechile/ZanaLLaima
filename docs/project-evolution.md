# ZanaLLaima: desarrollo integral de proyectos — contrato de implementación

Estado: **primera parte integrada en `main`**. Están conectadas como tools la entrevista, el plan, la propuesta de bootstrap y los borradores por cliente; el resto son contratos con tests que ninguna tool ejecuta todavía. Las secciones de abajo conservan el diseño y las notas de cuando se escribió.
Objetivo: GPT-6 Astra (configuración solicitada, esfuerzo `max`) coordina subagentes nativos cuando existan, sin inferencia externa, y ZanaLLaima aplica política, estado durable y revisión 4R sobre GitHub.

## Principios inmutables

- GPT es el único orquestador de razonamiento. Xanxito puede aportar control/lecturas locales, **nunca delegar a otros hosts** para este proyecto. Sin subagentes nativos verificados, ejecución secuencial transparente.
- El backend no consulta proveedores de modelos. No afirmar modelo ni esfuerzo efectivo sin evidencia del anfitrión.
- Ninguna respuesta de un LLM concede permisos: autorización autenticada de usuario, específica por efecto, objeto y alcance. Nunca repetir efectos dudosos tras timeouts.
- Para proyectos gestionados por ZanaLLaima, escrituras de código solo mediante `zana_ds_github`, con misión activa, unidad RUNNING y rama autorizada. La evolución del propio repositorio puede prepararse mediante el conector GitHub en una rama de PR por autorización expresa del operador; ese camino no produce un ticket, aprobación ni atestación 4R del harness. `main` y `.github/workflows/**` se mantienen protegidos.
- El revisor usa credencial GitHub distinta, solo del servidor; revisar exactamente el SHA comprobado, diff completo, CI real y cuatro lentes. No promover una «revisión independiente» sin identidad/aislamiento comprobable.
- La creación de un repositorio no significa permiso de desplegarlo. No implementar despliegue automático, publicación, gasto en nube ni ampliación de permisos por defecto.

## Fase 01. Discovery: de idea a plan maestro

### Contrato de datos

`src/project-discovery.mjs` implementa un contrato **puro** y local, sin estado en servidor ni efectos: `zana.discovery.v1` (idea, respuestas, revisión y estado) y `zana.project-plan.v1` (brief, alternativas documentadas, elección, hitos, digest SHA-256, aprobación pendiente). Validación estricta de campos, fechas, URLs y DAG de hitos. `skills/zana-project-discovery/SKILL.md` describe el flujo conversacional.

### Integración (hecha después de escribir esta sección)

Los dos puntos siguientes ya existen como `zana_workspace_create`, `_get`, `_update`, `_list` y `_set_archived` (`src/project-workspace.mjs`), con las limitaciones que describe `SECURITY.md`.

- API de borradores en servidor con `projectId` provisional y persistencia SQLite por operador, revisionado optimista por `expectedVersion`, límites y redacción. Nunca usar `memory.context` como fuente de autoridad.
- Tools MCP de lectura/escritura del borrador con identidad y alcance del usuario; evitar que un tercero recupere planes sensibles.
- Aprobación autenticada del **digest exacto**, destino, visibilidad y límites económicos. La aprobación debe invalidarse al cambiar el plan. Nunca aceptar un campo `approved: true` provisto por el modelo.
- Registro de fuentes tecnológicas con URL, fecha y conclusión contrastable; documentación oficial primero, Context7 como ayuda. Sin benchmarking sistemático.

## Fase 02. Bootstrap: repositorio y CI

- Crear repositorio solo cuando el operador autentique y confirme nombre, dueño, visibilidad, proveedor y huella del plan. `create_repository` está **denegada hoy** en la allowlist de la misión y no se debe habilitar globalmente.
- Introducir una **operación administrativa separada** (`bootstrap.create`) vinculada a ese consentimiento y a un intento durable (idempotency key); un fallo de red tras crear obliga a reconciliar repositorio/ID antes de reintentar.
- Configurar `main` y protecciones; CI por stack y repositorio. Instalar workflows mediante operador/bootstrap restringido (nunca dar a un agente escritor genérico acceso a `.github/workflows/**`). Los workflows nuevos llevan acciones fijadas, permisos mínimos y checks verificados.
- Enlazar el repositorio a allowlist y memoria por proyecto tras comprobar su ID. No aumentar el alcance de tokens de GitHub por conveniencia.

## Fase 03. Project Orchestrator: misiones y subagentes

- Plan maestro durable: estados `DRAFT -> APPROVED -> BOOTSTRAPPED -> ACTIVE -> READY_TO_DELIVER -> DELIVERED`, más `BLOCKED` y `CANCELLED`; eventos con `projectId`, `revision`, `missionId`, `sourceSha`, resultado y evidencias.
- Un plan se transforma en DAG de misiones acotadas. Con la versión actual de ZanaLLaima solo cabe **una misión activa a la vez**; implementar un coordinador de avance secuencial antes de pretender concurrencia entre repositorios.
- GPT decide cuándo repartir labores en subagentes nativos **realmente disponibles**; su número no es constante. Escrituras paralelas requieren ramas o worktrees aislados, grants por módulo y una integración controlada para evitar carreras.
- Carga progresiva de skills específicas, resultados MCP estructurados y compactos; referencias a artifacts/commit y no dumps completos de archivos por chat. No enviar tokens, decisiones privadas ni textos de autor al revisor.
- Replanificación acotada: cualquier cambio de alcance o arquitectura importante exige nueva revisión de plan y, si hay efectos nuevos, autorización autenticada.

## Fase 04. 4R: revisión con subagentes y cuenta separada

- Conservar íntegros `review-discipline`, `review-risk`, `review-readability`, `review-reliability`, `review-resilience`, `verification-law` cuando aplique, el diff paginado y `zana/4r` firmado.
- El coordinador GPT distribuye el SHA, la spec y el diff completo a cuatro contextos frescos; cada lente entrega hallazgos estructurados con `archivo:línea` y evidencia. El revisor **nunca** corrige el código.
- Problema por validar: el anfitrión debe proporcionar un identificador de subagente/actor comprobable o un mecanismo equivalente **a nivel backend**. Contexto fresco y nombre de subagente no prueban independencia ni aislamiento de permisos.
- La credencial revisora es exclusiva del backend, reutilizando el esquema de identidad separada existente. No liberar `zana_review_claim` a una sesión autora con `SAME_CLIENT` ni eludir `SESSION_WROTE`.
- Si no existe evidencia suficiente de identidad independiente, **mantener la revisión en conversación distinta** como mecanismo seguro de compatibilidad. Prohibido autoaprobar la revisión del autor.

## Fase 05. Delivery y continuidad

- Gates globales: aceptación de hitos, pruebas del stack, CI SHA exacto, revisión 4R, PR mergeable, autorización de merge y autorización de despliegue separadas.
- Reporte final: artefactos, arquitectura, riesgos abiertos, README, operación y rollback, costes observados cuando existan. No confundir deploy terminado con producto validado.
- Suscripciones MCP Events para CI finalizado, ticket listo, revisión solicitando cambios, misión lista y aprobación requerida **solo si se verifican soporte, firma, reconexión y deduplicación en el host real**. Eventos son avisos, no permisos ni pruebas por sí solos.
- MCP Apps/Extensions, cuando exista soporte real, mostrarán plan, hitos, PR, CI y autorizaciones; el backend sigue siendo fuente de verdad. Ningún control visual ejecuta acciones privilegiadas sin confirmación autenticada.
- Evaluar MCP `2026-07-28` y herramientas/tasks nuevas con pruebas de compatibilidad; conservar negociación/HTTP con sesiones para clientes actuales. Secure MCP Tunnel es opcional y no exige migrar Oracle/Cloudflare.

## Orden de ejecución y gates concretos

| Entrega | Resultado verificable | Puerta bloqueante |
|---|---|---|
| D1 | Contrato Discovery + skill + tests | CI del SHA + 4R independiente |
| D2 | Persistencia/recuperación de planes, aprobación por digest | Tests de autorización y recuperación + 4R |
| D3 | Bootstrap con create_repo separado + CI por stack | Consentimiento específico, idempotencia, prueba de acceso mínimo |
| D4 | Proyecto multipase, misiones dependientes y compactación | Aislamiento de escrituras y evidencias de progreso |
| D5 | 4R subagentes y cuenta revisora | Identidad no-autora comprobada y 4R adversarial |
| D6 | Delivery + eventos/UI + compatibilidad protocolo | E2E host, eventos firmados, rollback, autorización |

## Limitaciones observadas antes de escribir al repositorio

- La sesión MCP rechazó `zana_mission_init` para `owner/ZanaLLaima`: `REPO_NOT_ALLOWED`. Debe habilitarse explícitamente en `ZANA_GITHUB_REPOS`, preservando los repos actualmente permitidos. En esta evolución el usuario autorizó expresamente crear ramas y PR mediante el conector GitHub, **sin afirmar cobertura del gate de misión ZanaLLaima**; los PR requieren 4R independiente antes de integración.
- `zana_capability_status` indicó `executionMode: INLINE` y `verifiedNativeLaunches: 0` para esta sesión. No afirmar que se lanzaron cuatro subagentes.
- Xanxito confirmó después la autonomía `IMPLEMENT_AND_VERIFY` para un contrato de trabajo local. No se usa para delegar trabajos a otros hosts ni como sustituto de las garantías de ZanaLLaima.
- Cuando se escribió esta sección el código D1 estaba aislado. Después pasó CI y revisión con la cuenta revisora y se conectó como tools; la aprobación del plan por el usuario se implementó después (D2): la pide `zana_plan_approval_request` y la concede solo el operador en `/operator/approve`, sobre el digest exacto.
