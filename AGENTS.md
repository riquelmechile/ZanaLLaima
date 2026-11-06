# Contrato operativo de ZanaLLaima

Motor de misiones para **una sola cuenta GPT**, sin llamadas propias a APIs de inferencia, sin trabajo entre cuentas y sin dependencias de otros coordinadores. Usar solamente herramientas y subagentes nativos realmente disponibles en el anfitrión.

## Modo remoto (app de ChatGPT, 0.6.0)

1. Al empezar, cargar `zana-odd` con `zana_skill_load` y seguirla. Al recibir un ticket `ZR-...`, cargar `zana-4r` en esa conversación.
2. La verdad es el SHA en GitHub y sus checks de Actions. No hay shell: escribir **solo** con `zana_ds_github`, solo en `zana/<missionId>` y solo con una unidad `RUNNING` de la propia sesión. Nunca en la rama default ni en `.github/workflows/**`.
3. Orden: con la unidad de código RUNNING escribir, abrir el PR y correr checks hasta verde (`zana_checks_start`/`zana_checks_status`); luego `zana_complete_unit` (exige check verde sobre el head actual) y recién después `zana_review_request` (con una unidad de código RUNNING responde `UNIT_STILL_RUNNING`). `leaseSeconds` igual a `maxLeaseSeconds` en `zana_start_batch` y en cada `zana_unit_heartbeat`. Si la review pide cambios, `zana_correction_start` y un ticket nuevo. Si el lease venció: `zana_recover_expired` → `zana_unit_retry` → `zana_start_batch`. `zana_session_rebind` solo sirve con el lease vigente. Después del merge, `zana_mission_close` y `zana_mission_archive`.
4. La revisión la hace el mismo GPT en una **conversación nueva**, cuya primera tool es `zana_review_claim`; la sesión revisora queda en solo lectura y debe leer todo el diff (`zana_review_diff`). No reclamar el propio ticket ni rodear un rechazo (`AUTHOR_SESSION`, `SESSION_WROTE`, `SESSION_PREDATES_TICKET`, `REVIEWER_READ_ONLY`).
5. Declarar `execution` tal como ocurrió (`PARALLEL_SUBAGENTS` o `SEQUENTIAL_SAME_CONVERSATION`). Los lentes no corrigen código. No inventar evidencia.
6. `zana_merge` solo si el usuario lo pide y todo está verde sobre el mismo head. No aprobar ni descartar reviews, no desplegar.
7. Los tokens viven solo en el servidor. No pedirlos, no mostrarlos, no ponerlos en el repo.

El resto de este documento describe el **modo stdio**, que queda congelado: su código sigue probado pero no se endurece más.

## Configuración y misiones

1. Consultar \`zana_profile\`, \`zana_capability_status\` y \`zana_mission_status\`. La solicitud de modelo \`gpt-6-astra\` y esfuerzo \`max\` expresa la preferencia contractual, **no comprueba** qué modelo o esfuerzo ejecuta la sesión. No degradar deliberadamente el modelo y no inventar verificaciones.
2. Recuperar o conciliar el estado antes de crear otra misión. No sustituir una misión activa, cancelándose o incierta.
3. La misión requiere \`authorization\` y \`budget\` limitados. \`writesAllowed\` es solo una solicitud; ninguna escritura queda autorizada sin grant separado Ed25519 del operador.
4. Usar \`zana_next_batch\` y \`zana_start_batch\`. Conservar el \`token\`, \`leaseGeneration\` y \`expiresAt\` exactos. Reponer cupos READ disponibles de forma incremental, sin superar cuatro lecturas simultáneas o el presupuesto de la misión.
5. Solo declarar paralelismo si el anfitrión lanzó efectivamente contextos nativos. En ausencia de esa capacidad, ejecutar en secuencia y no inventar IDs, subagentes ni número de lanzamientos.
6. Enviar \`zana_complete_unit\` con pruebas reales y resultado fiel. Un plan o una respuesta de herramienta no demuestran ejecución.

## Frontera WRITE obligatoria (ZL-004)

**Toda mutación de archivos de una unidad WRITE debe pasar únicamente por \`zana_apply_write\`.** No modificar el workspace desde shell, IDE, Git, plugins ni otras herramientas del host como sustituto de ese efecto. Proporcionar el \`unitId\`, token, generación, ruta relativa exacta, contenido UTF-8 o \`deleteFile:true\`, y opcionalmente el SHA de preimagen.

El MCP revalida en el momento del efecto la firma Ed25519, vigencia y revocación del grant, lease, rutas de unidad y tamaño permitido. Usa descriptores anclados Linux, intención durable, fsync y recibos de SHA anterior/posterior. Esta versión permite **un solo efecto de archivo por intento**: para varios archivos crear unidades distintas.

Si el efecto queda \`OUTCOME_UNKNOWN\`, **jamás repetirlo automáticamente**. Una caída entre efecto y recibo deja una intención durable. Reconciliar con inspección y firma del operador; no deducir que la escritura no se realizó por la pérdida de una respuesta.

**Límite esencial:** las instrucciones no son permisos del SO. Antes de producción, ejecutar el proceso MCP con acceso de escritura exclusivo a un workspace que el usuario del anfitrión solo pueda leer. Comprobar con una prueba negativa de escritura directa. Sin aislamiento comprobado, ZL-004 está implementado localmente, pero el ejecutor real **no está verificado**.

## Recuperación, cuotas y SQLite

- SQLite WAL v6 guarda misiones, estados, recibos, historial, rondas RDD y límites inmutables. Revisar \`zana_storage_status\`, \`zana_storage_history\` y el archivo de misión.
- \`zana_unit_heartbeat\` solo puede extender un lease válido. Tras interrupción, usar \`zana_recover_expired\`; reintentar tareas READ agotadas solo cuando el presupuesto lo permite.
- Las escrituras siguen serializadas, nunca simultáneas ni mezcladas con READ. Un escritor autorizado que espera drena los READ activos.
- Ni la restauración de respaldos ni \`operator-import\` están expuestos como herramientas MCP: son acciones administrativas del CLI. No pedir llaves privadas al usuario ni exponerlas en respuestas.
- No ampliar deadlines, intentos, tamaño UTF-8 ni número de rondas por medios ajenos al contrato.

## Revisión RDD y entrega

Con todas las unidades terminadas y el árbol Git limpio, congelar HEAD, árbol, rama y SHA base mediante la observación real de Git. Abrir la revisión RDD y registrar cuatro lentes: riesgo, fiabilidad, resiliencia y claridad; usar el token de cada lente y evidencia verificable. Si cambia la candidata, invalidar recibos y repetir la revisión dentro de las rondas permitidas.

Una revisión de cuatro perspectivas en una sola sesión es **SELF_CHECK_COMPLETE_UNVERIFIED** y no es revisión independiente. Ni un reporte de contextos nativos ni un PASS propio autoriza merge, release o deploy.

El gate \`delivery-check\` requiere dos llaves Ed25519 **distintas** para la atestación CI y la aprobación del operador, SHA y base exactos, revisión efectiva y CI real. El firmante de \`ci-attestation.yml\` mediante \`workflow_run\` permanece desactivado mientras el operador no configure su environment, secreto y llave pública. El preflight devuelve \`releaseAuthorized:false\`; no cambiar ese valor para conseguir un PASS.

La rama \`main\` tiene checks y revisión externa obligatorios. No hacer merge, tag, release ni deploy por iniciativa del agente. Documentar el SHA exacto, checks, bloqueos y pasos humanos pendientes.

## Integración y límites

Seguir \`docs/host-codex.md\` para configurar MCP stdio y \`docs/host-e2e.md\` para el E2E real. **PASO HUMANO:** el operador ejecuta y commitea el reporte; no afirmar capacidades observadas desde tests locales. El transporte HTTP OAuth para la app de ChatGPT es el modo remoto de la versión 0.6.0 (`docs/deploy-remote.md`, `docs/host-e2e-remote.md`).

Mantener secretos, datos y artefactos dentro del repositorio/workspace autorizado. No introducir dependencias de otros sistemas de coordinación; el código reutilizado de otros proyectos lleva su procedencia en un comentario. Ante incertidumbre de permisos o estado, bloquear y reportar en vez de simular cumplimiento.
