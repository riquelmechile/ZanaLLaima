# Fase 5: auditoría de CI, seguridad del repositorio y release

**Fecha de corte:** 2026-11-03. **Repositorio:** `riquelmechile/ZanaLLaima`. **PR:** #1, rama `feat/gpt-native-solo-engine`. Esta evaluación documenta seguridad de entrega, no certifica que los agentes o el anfitrión GPT hayan sido probados realmente.

## Qué controla el CI

- Se utiliza **una ejecución por actualización del PR**: evento `pull_request`. El evento `push` se limita a `main`; `workflow_dispatch` es manual.
- El checkout usa el SHA explícito `github.event.pull_request.head.sha || github.sha` y comprueba `git rev-parse HEAD` antes de ejecutar código. El runner opera con permisos `contents: read`, `persist-credentials: false`, sin secretos de despliegue.
- Acciones oficiales fijadas a commits: checkout v4.2.2 `11bd71901bbe5b1630ceea73d27597364c9af683` y setup-node v4.4.0 `49933ea5288caeca8642d1e84afbd3f7d6820020`, verificados contra sus tags de GitHub.
- Instalación reproducible: `npm ci --ignore-scripts --no-audit --no-fund` con `package-lock.json` v3, resoluciones del registry npm y hashes de integridad de las dependencias. Sin instalación dinámica `npm install` en CI.
- Matriz: Node **22.16.0**, **22.23.4** y **24**, cada uno con sintaxis, preflight, suite de integración y estrés. Cobertura de `src/*.mjs` medida en Node 22.23.4; umbrales mínimos **90 % líneas, 80 % ramas y 85 % funciones** (no se cuentan los tests para aprobar los umbrales).
- Auditoría de producción: `npm audit --omit=dev --audit-level=high`, con fallo ante vulnerabilidades altas o críticas. Los resultados son específicos del commit y de la fecha del análisis, no una garantía perpetua.
- `timeout-minutes: 20`, `cancel-in-progress: true`, `strategy.fail-fast: false`. No se publican artefactos de release ni se hace merge o deploy.

El comando `npm run release:preflight` valida localmente la integridad estática del lockfile, versiones, acciones fijadas, permisos read-only, checkout del SHA exacto y ausencia de claves privadas rastreadas. Su salida incluye invariablemente `releaseAuthorized:false`: **no** es autoridad para hacer merge ni para desplegar.

**Evidencia de referencia:** el CI del SHA `d7fe3e8fac692d57407fb1a05d372d2e394c9d83` superó las tres versiones Node. En Node 22.23.4 midió 95,39 % de líneas de código fuente, 82,19 % de ramas y 88,83 % de funciones; el audit de producción informó cero vulnerabilidades. Los siguientes commits deben superar los nuevos umbrales sobre su propio SHA, no reutilizar esa ejecución.

## Hallazgos y puertas de seguridad

| Hallazgo | Severidad | Evidencia / mitigación | Estado |
| --- | --- | --- | --- |
| GitHub `main` sin protección efectiva | **BLOCKER** | `main.protected=false`, reglas `[]`; habilitar reglas con credencial administrativa | Pendiente ZL-026 |
| Escritor externo puede eludir el controlador MCP | **BLOCKER** | Firmas y rutas verificadas al reservar, no en toda mutación del ejecutor real; riesgo TOCTOU/symlink | Pendiente ZL-004 |
| Host GPT y subagentes no autenticados | **BLOCKER** | No se ha conectado ni medido un host real; no inferir modelo o independencia | Pendiente ZL-018 |
| Firma CI independiente aún no conectada | **HIGH** | `deliveryGate` valida firmas de prueba, pero aún no existe emisor CI externo autenticado | Pendiente |
| Sin revisión de PR verdaderamente independiente | **HIGH** | PR en borrador; una sola cuenta no convierte autocomprobaciones en revisión independiente | Pendiente |
| Planificador incremental y métricas sin terminar | **MEDIUM** | Fase 4 todavía pendiente por prioridad del propietario | Pendiente |
| Dependencias y acciones sin bloqueo previo | **HIGH, resuelto localmente** | Lockfile npm, `npm ci`, pins SHA, pruebas en matriz y auditoría de producción | Implementado |
| Eventos de CI duplicados | **MEDIUM, resuelto localmente** | Separación `pull_request` vs. `push: main` y cancelación por grupo | Implementado |
| SQLite experimental en Node 22 | **MEDIUM** | Pruebas en Node 22.16.0 y 22.23.4; compatibilidad también probada en Node 24 | Riesgo aceptado para desarrollo, no producción |

**Ningún gate de entrega permite merge o despliegue automáticamente**, incluso cuando un resultado firmado devuelve `READY_FOR_MANUAL_RELEASE`. El operador debe comprobar la autoridad real y autorizar cada acción por separado.

## Protección de GitHub que debe configurar el administrador

La conexión GitHub disponible permite lectura y escritura de archivos, pero **no** administración de ramas. Leer `/branches/main/protection` devuelve `403 Resource not accessible by integration`; no se debe afirmar protección aplicada por haber escrito este documento.

En `Settings → Rules → Rulesets` (o `Settings → Branches`, según capacidades del repositorio), crear una regla **activa** para `main` con:

1. Bloquear pushes directos, force-push y eliminación de la rama; exigir Pull Request.
2. Exigir al menos **una aprobación independiente** y descartar aprobaciones obsoletas cuando cambie el SHA. Resolver conversaciones antes de merge; no permitir que el autor apruebe su propio cambio.
3. Exigir los status checks de **todos los Node de la matriz** para el SHA actual, seleccionados exactamente desde la interfaz de GitHub después de una ejecución verde.
4. Evitar bypass de administradores, aplicaciones y bots, o justificarlo explícitamente mediante política humana.
5. No activar auto-merge ni despliegue por un `PASS` de RDD. La prueba independiente debe estar ligada al SHA revisado.

**Verificación requerida:** volver a consultar la protección/regla con una identidad autorizada y adjuntar evidencia del ruleset habilitado, checks exigidos y enforcement real. Hasta entonces, ZL-026 sigue abierto.

## Gates que siguen impidiendo release

- **ZL-004:** validar permisos al aplicar cada mutación del ejecutor real, no solo en el plan.
- **ZL-018:** conectividad ChatGPT real, modelo/esfuerzo observado y subagentes cuando existan.
- **Fase 4:** scheduler incremental, presupuestos, aislamiento de escrituras y benchmarks.
- **Gobernanza:** reglas de `main` y una revisión independiente sobre el SHA exacto.
- **CI confiable:** fuente auténtica de atestaciones CI vinculadas al SHA y al runner, separada del propio modelo.

Un informe local, un PDF, una ejecución de pruebas o una firma suministrada por el propio agente **no** reemplaza estas evidencias. El proyecto permanece local, sin servidor HTTP ni entrega automática.

## Comandos para repetir la comprobación

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run release:preflight
npm test
npm run test:stress
npm run test:coverage
npm audit --omit=dev --audit-level=high
```

Verificar el estado del PR y la rama de destino desde una cuenta autorizada antes de cualquier merge; **no** reutilizar resultados de otro commit.
