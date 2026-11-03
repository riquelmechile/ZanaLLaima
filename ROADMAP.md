# Roadmap técnico de ZanaLLaima

**Estado:** backlog propuesto, sin implementación de los cambios aquí enumerados.
**Corte de auditoría:** 2026-11-03, commit `df9535a41f774daa547b28812b5125765ce78238`, PR #1.
**Objetivo:** un único anfitrión GPT que planifique, ejecute con sus capacidades nativas, se recupere de interrupciones y revise resultados con evidencia verificable, sin delegación entre cuentas ni llamadas a APIs de inferencia.

## Principios que no deben perderse

- La solicitud de modelo `gpt-6-astra` y esfuerzo `max` no verifica la configuración real del anfitrión; nunca fingir esa verificación ni degradar deliberadamente el modelo.
- Emplear subagentes **solo si la aplicación anfitriona realmente los expone**. En ausencia de ellos, trabajar secuencialmente con el mismo GPT.
- Máximo cuatro trabajos independientes por tanda inicial. No escribir simultáneamente sobre estado compartido sin aislamiento probado.
- El permiso declarado en un JSON no equivale a una autorización del operador.
- Ningún `PASS` autodeclarado equivale a revisión independiente, aprobación de merge o autorización de despliegue.
- El estado persistido y la evidencia de Git/CI son fuentes distintas; exigir concordancia del SHA exacto.
- Mantener el proyecto autónomo, sin dependencias, vínculos ni referencias a otros sistemas de coordinación.

## Orden de ejecución

| Fase | Prioridad | Objetivo | Estado |
| --- | --- | --- | --- |
| 0 | P0 | Evitar bloqueos, errores de autorización y pérdidas de trabajo | [ ] Pendiente |
| 1 | P1 | Persistencia transaccional y recuperación tras reinicio | [ ] Código en revisión; bloqueada por fase 0 |
| 2 | P1 | RDD verificable sobre SHA exacto y revisión de una sola cuenta | [ ] Pendiente |
| 3 | P1 | MCP compatible e integración real con el anfitrión GPT | [ ] Pendiente |
| 4 | P2 | Aprovechar paralelismo nativo y mejorar rendimiento | [ ] Pendiente |
| 5 | P2 | CI, seguridad de repositorio y criterios de entrega | [ ] Pendiente |

### Fase 0. Seguridad funcional y ciclo de vida (P0)

- [ ] **ZL-001. Recuperación de tareas `RUNNING`.** Añadir lease, heartbeat, expiración, estado `OUTCOME_UNKNOWN` para escrituras y reconciliación explícita. Una pérdida de sesión no debe bloquear para siempre la misión ni provocar repetición ciega de efectos.
- [ ] **ZL-002. Misiones reutilizables.** Permitir cerrar, cancelar, archivar y crear una misión posterior sin borrar manualmente el archivo de estado. Conservar historial y controles de versión.
- [ ] **ZL-003. Fallos y reintentos.** Distinguir fallo reintentable, bloqueo, cancelación y efecto incierto. Añadir límites de reintento y replanificación de dependencias. Nunca marcar `DONE` una tarea dependiente de otra fallida.
- [ ] **ZL-004. Autorización auténtica de escrituras.** Separar la propuesta de la misión del consentimiento del operador; permisos efímeros, por ruta y operación, verificados también donde ocurren las escrituras. Prevenir traversal por rutas reales, enlaces simbólicos y cambios posteriores.
- [ ] **ZL-005. Pruebas adversariales.** Cubrir caída tras reservar tarea, caída después de escritura antes del recibo, doble finalización, reintentos obsoletos, permisos revocados y misión cancelada.

**Gate:** una simulación de reinicio o fallo no produce pérdida silenciosa, doble escritura ni bloqueo sin procedimiento de recuperación.

### Fase 1. Estado durable (P1; depende de fase 0)

**Implementación candidata en PR #1:** SQLite WAL, migración, recibos, backup/restauración y tests de concurrencia. No cerrar el gate ni interpretar el CI como verificación de ejecución autónoma hasta completar la Fase 0.

- [ ] **ZL-006. SQLite WAL.** Sustituir la reescritura completa del JSON por transacciones con esquema versionado, `busy_timeout`, WAL y migración conservadora del estado previo; incluir backup y rollback.
- [ ] **ZL-007. Exclusión real entre procesos.** Probar dos procesos compitiendo por la misma tarea, escritura y resultado; asegurar un único ganador y fencing por intento/generación.
- [ ] **ZL-008. Política de historial.** Guardar resultados RDD y ejecuciones de forma consultable, paginada y acotada; separar estado activo del histórico.
- [ ] **ZL-009. Recuperación de almacenamiento.** Probar interrupciones en fronteras transaccionales, corrupción, errores de disco y restauración de backups.

**Gate:** reinicio y concurrencia multiproceso conservan invariantes, identidad de intentos y recibos, sin estado duplicado.

### Fase 2. RDD de una sola cuenta (P1; depende de fases 0 y 1)

- [ ] **ZL-010. Evidencia Git real.** Leer el HEAD/árbol real desde un componente autorizado y congelar SHA de 40 caracteres, destino y limpieza del worktree. No confiar únicamente en un SHA pasado como argumento.
- [ ] **ZL-011. Revisión 4R adaptable.** Limitar los paquetes al número **efectivamente observado** de contextos nativos. Si se pierde capacidad, transicionar de forma controlada al modo secuencial sin fingir independencia.
- [ ] **ZL-012. Procedencia y aislamiento.** Registrar ID de contexto, ejecución y candidato; impedir contaminación entre perspectivas y no elevar reportes autodeclarados a atestaciones verificadas.
- [ ] **ZL-013. Corrección y nuevo candidato.** Fallos bloqueantes exigen cambios explícitamente autorizados, nuevo SHA, invalidación de recibos anteriores y revisión desde cero. Limitar correcciones repetidas.
- [ ] **ZL-014. Gate de entrega separado.** Combinar evidencia Git, CI del SHA exacto, hallazgos y aprobación del operador sin confundir “revisión terminada” con permiso de merge/deploy.
- [ ] **ZL-015. Pruebas RDD.** Casos de SHA cambiado durante revisión, contextos repetidos, subagente ausente, evidencia inventada, pruebas vencidas y hallazgos críticos.

**Gate:** cuatro perspectivas completan su ciclo, pero solo una autoridad independiente basada en evidencia real puede elevar el estado de revisión. Sin prueba externa, `approved: false`.

### Fase 3. MCP e integración de anfitrión (P1; depende de fase 0; puede avanzar en paralelo a fases 1 y 2)

- [ ] **ZL-016. SDK MCP oficial.** Reemplazar o encapsular el parser `stdio` manual; validar negociación de versiones, esquema, notificaciones, cancelación y errores recuperables `isError`.
- [ ] **ZL-017. Contrato de capacidades.** Distinguir `REQUESTED`, `HOST_REPORTED` y `VERIFIED`; nunca permitir que un informe del modelo cambie permisos efectivos.
- [ ] **ZL-018. Prueba con una cuenta GPT real.** Verificar, con recibos observables, qué controles de modelo/esfuerzo y qué lanzadores nativos existen en esa superficie; medir cuántos subagentes funcionan de verdad.
- [ ] **ZL-019. Sin subagentes.** Completar una misión y su 4R en un solo contexto, sin fingir paralelismo ni independencia.
- [ ] **ZL-020. Límite de exposición.** Mantener `stdio` local por defecto. Cualquier interfaz remota requiere diseño explícito de autenticación, autorización, transporte seguro, cuotas y pruebas negativas antes de habilitarla.

**Gate:** un cliente MCP compatible completa una misión real end-to-end, con comportamiento comprobado en modo individual y modo nativo si está disponible.

### Fase 4. Rendimiento y planificación (P2; depende de fases 0 y 1)

- [ ] **ZL-021. Planificación incremental.** Admitir nuevos trabajos independientes cuando quede capacidad libre, sin esperar a que termine toda la tanda anterior.
- [ ] **ZL-022. Aislamiento de escrituras.** Mantener un único escritor; ampliar a escritores paralelos solo con worktrees realmente aislados, permisos diferenciados y tests de conflicto.
- [ ] **ZL-023. Rendimiento de almacén.** Medir latencia de lectura/escritura, tamaño de historial, concurrencia y recuperación. Optimizar con datos, no por intuición.
- [ ] **ZL-024. Límites de recursos.** Establecer presupuesto por misión, trabajo, revisión, reintento, longitud de resultado y tiempo de espera.

**Gate:** benchmarks reproducibles demuestran mejora de throughput sin vulnerar los invariantes de estado y autorización.

### Fase 5. Calidad y entrega (P2; transversal)

- [ ] **ZL-025. CI robusto.** Tests de integración, estrés, fallos de proceso, cobertura e incompatibilidades MCP; fijar versiones de acciones por SHA, permisos mínimos y timeout.
- [ ] **ZL-026. Seguridad del repositorio.** Proteger `main` y exigir CI del SHA exacto y revisión independiente antes de merge. Auditar rulesets/branch protection con una credencial administrativa autorizada.
- [ ] **ZL-027. Reducir trabajo duplicado.** Revisar la duplicación de CI para `push` y `pull_request` y adoptar concurrency/cancel-in-progress cuando sea seguro.
- [ ] **ZL-028. Documentación.** Sincronizar README con el inventario real de 12 herramientas MCP y añadir guía de recuperación, operación local y límites de evidencia.
- [ ] **ZL-029. Revisión de seguridad de release.** Evaluar rutas, bloqueo de estado, secretos, errores y superficies expuestas; no desplegar sin superar los gates anteriores.

**Gate:** CI verde, revisión real y reproducible, controles de rama comprobados, E2E documentado y aprobación humana para cualquier entrega.

## Hallazgos confirmados que originan el roadmap

- `src/core.mjs`: `RUNNING` bloquea nuevas tandas; no hay recuperación, cancelación o retry; el contrato de capacidad no inicia realmente subagentes.
- `src/actions.mjs`: no admite iniciar otra misión cuando ya existe un archivo de estado.
- `src/review.mjs`: prepara cuatro lentes nativos sin usar el límite real de concurrencia; acepta SHA informado por el cliente; no implementa replanificación de capacidad.
- `src/store.mjs`: persiste con un JSON completo y lock sin reconciliador; carece de pruebas de caída del proceso.
- `src/mcp.mjs`: adaptador manual local, sin prueba de compatibilidad con cliente oficial moderno.
- `.github/workflows/ci.yml`: pruebas unitarias y sintaxis, sin matriz de recuperación, cobertura ni validación de integraciones reales.
- GitHub al corte: PR #1 abierto como borrador, 14 pruebas correctas, sin revisiones formales registradas, `main` reportada sin protección activa.

## Prioridad de implementación

Primero ZL-001 a ZL-005. Después persistencia y RDD confiable. Integración real con el anfitrión puede desarrollarse en paralelo siempre que no omita los controles de permisos. Rendimiento y automatización de entrega se abordan después de asegurar recuperación y evidencia.

**Criterio de versión lista:** una única cuenta GPT puede iniciar más de una misión en momentos distintos, completar trabajo, recuperarse de interrupciones, ejecutar las cuatro perspectivas con procedencia honesta y presentar una decisión verificable sobre un candidato Git sin declarar aprobaciones o capacidades inexistentes.
