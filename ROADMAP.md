# Roadmap técnico de ZanaLLaima

**Estado:** seguimiento vivo de fases implementadas localmente y gates pendientes de integración.
**Corte de auditoría:** 2026-11-04. Base confirmada del cierre: `79ef90260768da3a606060a2213fb1e8db3599a6`; para el SHA final ver el HEAD del PR #1, pues escribirlo dentro de su propio commit cambiaría ese hash.
**Objetivo:** un único anfitrión GPT que planifique, ejecute con sus capacidades nativas, se recupere de interrupciones y revise resultados con evidencia verificable, sin delegación entre cuentas ni llamadas a APIs de inferencia.

## Candidato 0.4.1: límites Git y restauración monotónica (sin release)

- **RDD P1-a/P1-b:** reemplazar `git status` por comparación de entradas `git ls-files -s -z` frente a `git ls-tree -r -z HEAD`; comprobar blobs sin filtros con `git hash-object --no-filters`, permisos y symlinks, y archivos no rastreados con `git ls-files --others --exclude-standard -z`. Repetirlo en submódulos y exigir coincidencia de gitlinks. No ejecutar drivers de atributos ni confiar en `config.worktree`, `include` o `includeIf`.
- **Persistencia P1-c:** unión monotónica de `operator_actions` y grants revocados desde la base viva al candidato de restauración. `forceDataLoss` no puede restaurar autorizaciones revocadas. Base viva ilegible: revocar todos los grants restaurados y exigir consentimiento explícito.
- **P2 de Codex tras primera revisión:** comprobar mediante `lstat` cada componente intermedio de rutas rastreadas. Un directorio sustituido por symlink, incluso a un destino interno y con rutas excluidas del recuento de no rastreados, deja `clean:false`. Prueba con uno y dos niveles, fix `d14711e`.
- **Evidencia:** tests negativos Git locales y cuatro negativos SQLite rojos en GitHub CI antes de aplicar el fix; después exigir cobertura sin bajar umbrales, suite, estrés, benchmark y auditoría en el SHA final.
- **Gates:** nueva revisión Codex con recibo completado y nueva 4R independiente de `sebastianriquelme95-max`. Sin aprobación, firma CI real, merge ni despliegue.

## Seguimiento 0.3.3 (candidato, sin release)

- **RDD / ZL-010:** inspeccionar recursivamente los índices **y el estado de cada worktree** de los submódulos, aun cuando las configuraciones de ignorado de un segundo nivel oculten archivos modificados al repositorio raíz. Regresión \`root/lib/inner\` para \`submodule.inner.ignore=all\`; ningún snapshot RDD debe declararse limpio si un submódulo rastreado cambió.
- La revisión Codex del SHA exacto, los checks CI, la atestación real y la aprobación independiente siguen siendo puertas separadas. No confundir código corregido con revisión completa ni con release autorizado.

## Candidato 0.4.0: seguridad CI y rutas

- **CRITICAL C1:** `workflow_run` sobre `main`, código del firmante confiable y checks de GitHub API; `ci-attestation` con required reviewer y política main-only deberá configurarlo y comprobarlo el operador.
- **CRITICAL C2:** Git fail-closed con `fsmonitor`/hooks/filters deshabilitados o rechazados, también en submódulos.
- **WARNING:** frontera única de rutas, evidencia de reconciliación, FD y rollback seguros, temporales WRITE con intención durable y restore con consentimiento explícito ante posible pérdida de datos.
- **W6:** conservar `BEGIN IMMEDIATE` durante efecto para impedir revocación concurrente; timeout cooperativo de 5 s antes del `rename`. El kernel puede bloquear `fsync` más tiempo; sigue pendiente una solución con I/O aislado si se exige un deadline duro.
- **Gate:** CI y Codex sobre SHA final, y nueva revisión independiente de `sebastianriquelme95-max`; `releaseAuthorized:false` hasta atestación firmada, aislamiento del host y aprobación humana. Sin merge ni deploy.

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
| 0 | P0 | Evitar bloqueos, errores de autorización y pérdidas de trabajo | [ ] Control local probado; gate real de escrituras del anfitrión pendiente |
| 1 | P1 | Persistencia transaccional y recuperación tras reinicio | [x] Implementada y probada; gate operacional pendiente de Fase 0 |
| 2 | P1 | RDD verificable sobre SHA exacto y revisión de una sola cuenta | [x] Motor local y pruebas; integración real pendiente |
| 3 | P1 | MCP compatible e integración real con el anfitrión GPT | [ ] SDK y E2E local implementados; ZL-018 real pendiente |
| 4 | P2 | Aprovechar paralelismo nativo y mejorar rendimiento | [x] Planificador, cuotas y benchmark locales probados; E2E host pendiente |
| 5 | P2 | CI, seguridad de repositorio y criterios de entrega | [x] CI, documentación, auditoría y protección de main verificadas; release real pendiente |

### Fase 0. Seguridad funcional y ciclo de vida (P0)

**Implementación en PR #1:** leases/heartbeat y fencing, transición de escrituras a OUTCOME_UNKNOWN, reconciliación firmada por el operador, cancelación/cierre/archivo de misiones, control separado de permisos WRITE, inspección de rutas y pruebas de fallos. Los permisos deben aplicarse nuevamente en el **ejecutor efectivo del anfitrión**, que todavía no está integrado; este gate impide declarar operación autónoma en producción. Ver `docs/safety-lifecycle.md`.

- [x] **ZL-001. Recuperación de tareas `RUNNING`.** Añadir lease, heartbeat, expiración, estado `OUTCOME_UNKNOWN` para escrituras y reconciliación explícita. Una pérdida de sesión no debe bloquear para siempre la misión ni provocar repetición ciega de efectos.
- [x] **ZL-002. Misiones reutilizables.** Permitir cerrar, cancelar, archivar y crear una misión posterior sin borrar manualmente el archivo de estado. Conservar historial y controles de versión.
- [x] **ZL-003. Fallos y reintentos.** Distinguir fallo reintentable, bloqueo, cancelación y efecto incierto. Añadir límites de reintento y replanificación de dependencias. Nunca marcar `DONE` una tarea dependiente de otra fallida.
- [x] **ZL-004. Autorización auténtica de escrituras.** Separar la propuesta de la misión del consentimiento del operador; permisos efímeros, por ruta y operación, verificados también donde ocurren las escrituras. Prevenir traversal por rutas reales, enlaces simbólicos y cambios posteriores.
- [x] **ZL-005. Pruebas adversariales.** Cubrir caída tras reservar tarea, caída después de escritura antes del recibo, doble finalización, reintentos obsoletos, permisos revocados y misión cancelada.

**ZL-004: implementado localmente.** `zana_apply_write` revalida grant Ed25519, lease, scope y bytes en el efecto, usa descriptores Linux, intención durable y recibos SHA. Una caída deja `OUTCOME_UNKNOWN` y bloquea repetición automática. **Gate operacional pendiente:** demostrar que las herramientas del host sin MCP no pueden escribir en el workspace por permisos del SO.

**Gate local verificado:** las transiciones conservan estado y exigen reconciliación antes de cualquier reintento WRITE. **Gate operativo pendiente:** un ejecutor anfitrión real debe demostrar que ninguna herramienta puede escribir saltándose los permisos y que la autorización se revalida al aplicar cada efecto.

### Fase 1. Estado durable (P1; depende de fase 0)

**Implementación en PR #1:** SQLite WAL con unidades normalizadas, migración JSON preservando original, recibos y generación inicial por ejecución, backup/restauración offline, historial paginado con retención y pruebas multiproceso, corrupción y recuperación. Código de Fase 1 entregado; **el gate de operación autónoma sigue bloqueado por Fase 0**. La generación de intentos no puede renovarse automáticamente hasta implementar reconciliación de efectos inciertos.

- [x] **ZL-006. SQLite WAL.** Sustituir la reescritura completa del JSON por transacciones con esquema versionado, `busy_timeout`, WAL y migración conservadora del estado previo; incluir backup y rollback.
- [x] **ZL-007. Exclusión real entre procesos.** Probar dos procesos compitiendo por la misma tarea, escritura y resultado; asegurar un único ganador y fencing por intento/generación.
- [x] **ZL-008. Política de historial.** Guardar resultados RDD y ejecuciones de forma consultable, paginada y acotada; separar estado activo del histórico.
- [x] **ZL-009. Recuperación de almacenamiento.** Probar interrupciones en fronteras transaccionales, corrupción, errores de disco y restauración de backups.

**Gate:** reinicio y concurrencia multiproceso conservan invariantes, identidad de intentos y recibos, sin estado duplicado.

### Fase 2. RDD de una sola cuenta (P1; depende de fases 0 y 1)

**Implementación local candidata PR #1:** Git HEAD/árbol/destino y worktree limpio comprobados por proceso local; revisión 4R adaptable (1–4), fallback secuencial y procedencia etiquetada sin afirmar independencia; invalidación de SHA y máximo cinco rondas verificadas; gate de entrega con atestaciones Ed25519 separadas de CI y operador. **No hay lanzamientos reales de subagentes ni fuente CI conectada todavía**. El gate operativo queda pendiente de la futura fase de integración.

- [x] **ZL-010. Evidencia Git real.** Leer el HEAD/árbol real desde un componente autorizado y congelar SHA de 40 caracteres, destino y limpieza del worktree. No confiar únicamente en un SHA pasado como argumento.
- [x] **ZL-011. Revisión 4R adaptable.** Limitar los paquetes al número **efectivamente observado** de contextos nativos. Si se pierde capacidad, transicionar de forma controlada al modo secuencial sin fingir independencia.
- [x] **ZL-012. Procedencia y aislamiento.** Registrar ID de contexto, ejecución y candidato; impedir contaminación entre perspectivas y no elevar reportes autodeclarados a atestaciones verificadas.
- [x] **ZL-013. Corrección y nuevo candidato.** Fallos bloqueantes exigen cambios explícitamente autorizados, nuevo SHA, invalidación de recibos anteriores y revisión desde cero. Limitar correcciones repetidas.
- [x] **ZL-014. Gate de entrega separado.** Combinar evidencia Git, CI del SHA exacto, hallazgos y aprobación del operador sin confundir “revisión terminada” con permiso de merge/deploy.
- [x] **ZL-015. Pruebas RDD.** Casos de SHA cambiado durante revisión, contextos repetidos, subagente ausente, evidencia inventada, pruebas vencidas y hallazgos críticos.

**Gate local:** cuatro perspectivas con procedencia honesta, invalidez ante Git cambiante y firmas verificadas. Sin prueba externa, `approved: false`. **Gate E2E pendiente:** aislamiento real de contextos y atestaciones CI producidas por un verificador conectado; no considerar el RDD independiente ni autorizado para despliegue antes de la fase de integración.

### Fase 3. MCP e integración de anfitrión (P1; depende de fase 0; puede avanzar en paralelo a fases 1 y 2)

**Código desarrollado en PR #1:** SDK oficial MCP v2 `stdio` con esquemas de entrada y errores `isError`; capacidad `requested` / `hostReported` / `verified` (sin evidencia real de modelo); cliente SDK que completa misión READ y 4R secuencial; cancelación cooperativa y alcance exclusivamente local. Ver `docs/mcp-v2.md`. **ZL-018 permanece abierto por decisión de terminar el software antes de conectar y probar una cuenta ChatGPT real.** No atribuir al test local independencia de subagentes o certificación de anfitrión.

- [x] **ZL-016. SDK MCP oficial.** Reemplazar o encapsular el parser `stdio` manual; validar negociación de versiones, esquema, notificaciones, cancelación y errores recuperables `isError`.
- [x] **ZL-017. Contrato de capacidades.** Distinguir `REQUESTED`, `HOST_REPORTED` y `VERIFIED`; nunca permitir que un informe del modelo cambie permisos efectivos.
- [ ] **ZL-018. Prueba con una cuenta GPT real.** Verificar, con recibos observables, qué controles de modelo/esfuerzo y qué lanzadores nativos existen en esa superficie; medir cuántos subagentes funcionan de verdad.
- [x] **ZL-019. Sin subagentes.** Completar una misión y su 4R en un solo contexto, sin fingir paralelismo ni independencia.
- [x] **ZL-020. Límite de exposición.** Mantener `stdio` local por defecto. Cualquier interfaz remota requiere diseño explícito de autenticación, autorización, transporte seguro, cuotas y pruebas negativas antes de habilitarla.

**Gate local superado:** cliente oficial SDK en `stdio` y misión READ+4R completa sin subagentes. **Gate real pendiente:** validar conexión a ChatGPT, configuración efectiva, permisos del ejecutor y lanzamiento de contextos nativos cuando la aplicación los exponga. Nada de esto ha sido simulado como aprobación.

### Fase 4. Rendimiento y planificación (P2; depende de fases 0 y 1)

**Implementación local de fase 4:** se reponen cupos READ mientras continúan otros trabajos; se prioriza el drenaje de lecturas ante un WRITE firmado; SQLite impide transiciones que solapen escritores; los límites de misión, intentos, leases, resultados y rondas RDD son inmutables y persistentes (`user_version=4`). `scripts/benchmark-phase4.mjs` registra latencia p50/p95 de SQLite, tamaño, historial, contención y recuperación, y compara tiempos lógicos deterministas. **No se midió throughput de agentes GPT reales ni se habilitaron escritores paralelos**. Ver `docs/phase4-performance.md`.


- [x] **ZL-021. Planificación incremental.** Admitir nuevos trabajos independientes cuando quede capacidad libre, sin esperar a que termine toda la tanda anterior.
- [x] **ZL-022. Aislamiento de escrituras.** Mantener un único escritor; ampliar a escritores paralelos solo con worktrees realmente aislados, permisos diferenciados y tests de conflicto.
- [x] **ZL-023. Rendimiento de almacén.** Medir latencia de lectura/escritura, tamaño de historial, concurrencia y recuperación. Optimizar con datos, no por intuición.
- [x] **ZL-024. Límites de recursos.** Establecer presupuesto por misión, trabajo, revisión, reintento, longitud de resultado y tiempo de espera.

**Gate local:** pruebas multiproceso, estrés y benchmark reproducible, con ganancia de *tiempo lógico simulado* frente a barreras. Las operaciones SQLite sí se miden en tiempo real. **Gate host pendiente:** observar throughput de tareas nativas realmente lanzadas y probar enforcement de escrituras del ejecutor, sin presentar simulaciones como aprobaciones independientes.

### Fase 5. Calidad y entrega (P2; transversal)

**Ejecución de Fase 5:** `package-lock.json` reproducible, `npm ci`, acciones de GitHub fijadas por SHA, permisos `contents: read`, Git checkout del HEAD exacto, matriz Node 22.16.0/22.23.4/24, cobertura del código fuente con umbral, pruebas de estrés/seguridad y auditoría de dependencias. `pull_request` ejecuta el CI una sola vez por actualización y `push` solo en `main`. El preflight estático nunca autoriza merge/deploy. Ver `docs/release-security.md`.

**ZL-026 resuelto y verificado:** el token de la integración de archivos no administra reglas, pero una sesión GitHub CLI autorizada de `riquelmechile` con `permissions.admin=true` aplicó protección a `main`. Se comprobó por GET administrativo que están activos tres checks obligatorios, revisión independiente, invalidación de aprobaciones obsoletas, aprobación posterior al último push, resolución de conversaciones, reglas para administradores y prohibición de force-push/eliminación. Una segunda lectura de GitHub confirmó `main.protected=true`. Se utilizó **branch protection**, no un ruleset; el listado de rulesets puede seguir vacío sin invalidar la protección.

**Bloqueo de release ZL-029:** frontera WRITE del MCP implementada; faltan aislamiento del host por SO (ZL-004 operacional), prueba real de Codex (ZL-018), rendimiento nativo, atestación CI firmada por emisor real y revisión de GitHub independiente. Esto impide producción.


- [x] **ZL-025. CI robusto.** Tests de integración, estrés, fallos de proceso, cobertura e incompatibilidades MCP; fijar versiones de acciones por SHA, permisos mínimos y timeout.
- [x] **ZL-026. Seguridad del repositorio.** Proteger `main` y exigir CI del SHA exacto y revisión independiente antes de merge. Auditar rulesets/branch protection con una credencial administrativa autorizada.
- [x] **ZL-027. Reducir trabajo duplicado.** Revisar la duplicación de CI para `push` y `pull_request` y adoptar concurrency/cancel-in-progress cuando sea seguro.
- [x] **ZL-028. Documentación.** Sincronizar README con el inventario real de 24 herramientas MCP y añadir guía de recuperación, operación local y límites de evidencia.
- [x] **ZL-029. Revisión de seguridad de release.** Evaluar rutas, bloqueo de estado, secretos, errores y superficies expuestas; no desplegar sin superar los gates anteriores.

**Gate:** CI verde, revisión real y reproducible, controles de rama comprobados, E2E documentado y aprobación humana para cualquier entrega.

## Hallazgos de la auditoría inicial (históricos; no describen el código actual)

Los puntos siguientes fueron constatados sobre el commit de auditoría original y motivaron este roadmap. Muchos ya cuentan con correcciones y pruebas posteriores; consultar el estado de cada ZL antes de tratarlos como defectos actuales.

- `src/core.mjs`: originalmente no había recuperación ni reintentos. Ya se implementaron leases/reconciliación local, pero el contrato sigue sin iniciar subagentes reales.
- `src/actions.mjs`: inicialmente no admitía más misiones; ahora existe cierre y archivo persistente.
- `src/review.mjs`: los defectos iniciales de cupo y SHA cliente se corrigieron con planificación adaptable y Git local; faltan contextos reales del anfitrión.
- `src/store.mjs`: el almacén JSON fue reemplazado por SQLite WAL con pruebas de concurrencia, caída y restauración.
- `src/mcp.mjs`: el adaptador manual fue sustituido por SDK MCP v2 con pruebas del cliente oficial local.
- `.github/workflows/ci.yml`: las pruebas originales eran limitadas; el pipeline actual incluye lockfile, matriz Node, estrés, cobertura y seguridad; E2E ChatGPT real todavía no existe.
- GitHub al corte original: PR #1 en borrador, 14 pruebas y `main` desprotegida. Durante Fase 5 se habilitó protección real de `main`; el resto de métricas iniciales son históricas.

## Prioridad de implementación

ZL-001 a ZL-003 y ZL-005 a ZL-009 tienen implementación local y pruebas; ZL-004 cuenta con enforcement local en el MCP; permanece pendiente demostrar que el host no puede escribir por herramientas externas. Debe validarse la aplicación efectiva de permisos en el anfitrión antes de operar autónomamente. La implementación local de RDD, SDK MCP y gates CI/release ya está desarrollada. Las fases de implementación local 1, 2, 4 y 5 están desarrolladas; faltan aislamiento SO del host (ZL-004 operacional), atestaciones externas, revisión independiente, conexión y E2E real de GPT (ZL-018) antes de liberar software.

**Criterio de versión lista:** una única cuenta GPT puede iniciar más de una misión en momentos distintos, completar trabajo, recuperarse de interrupciones, ejecutar las cuatro perspectivas con procedencia honesta y presentar una decisión verificable sobre un candidato Git sin declarar aprobaciones o capacidades inexistentes.


### Cierre de ZL-004, frontera local de efectos

Se incorporó `zana_apply_write` como herramienta MCP 24, con intentos durables, validación de grants Ed25519 y lease, anclaje Linux de directorios, rechazo de symlink/hardlink, recibos SHA y tests de caída real tras el efecto. El preflight puede reportar `MCP_EFFECT_BOUNDARY_ENFORCED`, **no `VERIFIED`**, porque un modelo con otras herramientas del SO podría saltarse el MCP. El gate real sigue abierto hasta probar la separación de permisos del host.

### Cierre candidato 0.3.0 (sin release)

- **ZL-004 local:** herramienta MCP 24 con efecto atómico de archivo, firma Ed25519, lease, rutas, recibo SHA, prueba de caída posterior al efecto y pruebas negativas. **Host y aislamiento SO no verificados**.
- **Emisor CI preparado, sin activación:** `scripts/ci-attest.mjs` y job de Actions `attest` bajo `ci-attestation`. El archivo `keys/ci-verifier.pub` es un marcador, no una llave real. **PASO HUMANO:** generar dos llaves distintas (CI y operador), cargar secret, environment protegido y variable de activación, y validar un run firmado. El gate `trustedCIAttribution` queda `NOT_CONNECTED` hasta entonces.
- **Cobertura:** global 92/85/90 y bloqueo automático si cualquier módulo de `src/` cae bajo 80 % de ramas.
- **ZL-018 permanece abierto:** guías `docs/host-codex.md` / `docs/host-e2e.md` y plantilla `examples/host-e2e-report.json`; sin ejecución con Codex real ni informe verificado.
- **Revisión independiente abierta:** el ciclo 4R solo puede etiquetarse como self-check; se requiere otra cuenta Github y evaluación humana sobre SHA exacto.


### Ronda 2: cuatro hallazgos corregidos, candidata 0.3.1

Auditoría inicial: commit `a36120b4d0a03f61445dbfcff32e382390e95e14`. Se publicaron cuatro correcciones separadas, sin cambiar `main`:

| Severidad | Hallazgo | Commit corrector | Verificación |
| --- | --- | --- | --- |
| P1 | Deadlock de dos `transact()` del mismo proceso | `0dfbc8d8553d8189735cc3d8ec8c744b4c15d7a9` | Cola asíncrona de SQLite; 200 ms de espera, rollback, 8 mutaciones MCP concurrentes y estrés entre procesos |
| P2 | Reemplazo atómico perdía permisos POSIX | `931921a41109a665e0dbffcf4b73c400ff3991aa` | Conservación `0755`/`0644`, descarte de setuid, nuevo archivo `0600`, recibos de modos y migración SQLite v5→v6 |
| P2 | Heartbeat CLI forzaba 300 segundos | `44d9a441d198e15d8e64081e450b4ec84529f2ec` | CLI y MCP stdio sin default fijo con presupuesto de 60 s; rechazo de 61 s |
| P2 | Review invalidada no reabría el mismo SHA tras cambiar base | `2b91918bd478271b1869c7fadd3b5ccdc3d605eb` | Git real: cambia `main`, feature HEAD idéntico, nueva ronda y archivo; rechaza revisión viva, snapshot idéntico y presupuesto agotado |

**Versión candidata:** `0.3.1` sin tag, release ni deploy. Los umbrales de cobertura global 92/85/90 y por módulo (mínimo 80 % de ramas) siguen activos. Los hilos del revisor no se resuelven artificialmente: cada respuesta apunta al SHA corrector y queda sujeta a otra pasada.

**Gates que no se cierran con estos cuatro fixes:** CI firmado con secretos humanos y llaves públicas verificables; aislamiento real del anfitrión por permisos del SO; ZL-018 (E2E Codex ejecutado y registrado por Zana); revisión independiente y aprobación de GitHub distinta del autor. `releaseAuthorized:false` sigue siendo obligatorio.

### Seguimiento de revisión Codex sobre 0.3.1 (2026-11-04)

Los cuatro hallazgos originales se corrigieron en commits separados: P1 cola SQLite `0dfbc8d`, P2 modos de archivos `931921a`, P2 lease CLI `44d9a44` y P2 reapertura Git RDD `2b91918`. Los hilos originales recibieron respuesta con SHA y CI por cada cambio, sin simular aprobación independiente.

Una revisión intermedia detectó dos P2 adicionales en `src/lifecycle.mjs`, corregidos en `0fbe62a` (no acortar leases al renovar) y `2603dbf` (cancelación invalida paquetes RDD, permite archivar). Cada corrección incluye pruebas negativas y mantiene el gate de release cerrado. Revalidar el SHA final y CI tras actualizar la documentación; pedir nueva revisión Codex sobre ese SHA. Las conversaciones siguen abiertas hasta verificación de la revisión.

### Ronda 3 de seguridad, candidata 0.3.2

Codex identificó un P1 de regrant después de intención WRITE y un P2 de flags Git que ocultaban modificaciones. Se añadieron pruebas negativas: la segunda fase conserva el grant original y Git RDD rechaza assume-unchanged/skip-worktree. Se preparó un script idempotente de configuración humana de CI con simulación sin efectos y un checklist de operador. El preflight conserva releaseAuthorized:false y trustedCIAttribution:NOT_CONNECTED hasta evidencia real. Los hilos solo se resuelven si la última revisión Codex finaliza sin hallazgos, y no hay merge, release, tag ni deploy.

- P2 adicional: inspección de submódulos pese a submodule.ignore=all, corregida en 7094de824757c4abafb96441dd34dd553cb172be; test Git con cambios internos.

### Corrección adicional de revisión Codex · 0.3.2

`ebd8c9b`: `observeGit()` inspecciona recursivamente los índices de los submódulos para impedir que flags `assume-unchanged` o `skip-worktree` oculten cambios rastreados. Dos regresiones con repositorios reales añadidas a `tests/git-evidence.test.mjs`. Requiere nueva revisión Codex y security review sobre el HEAD posterior a este commit; no implica aprobación independiente.
