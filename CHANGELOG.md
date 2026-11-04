# Registro de cambios

## [0.3.0] - No publicado

Versión candidata en PR #1. Sin tag, release ni despliegue.

### Añadido

- \`zana_apply_write\`: frontera de efectos locales con permiso firmado Ed25519, lease, rutas y comprobación de preimagen; 24 herramientas MCP.
- Intenciones durables, recibos de SHA previos y posteriores y estado \`OUTCOME_UNKNOWN\` ante caídas antes de confirmar el recibo. Esquema SQLite v5.
- Anclaje Linux por descriptores y rechazo de rutas con symlinks, hardlinks o destinos irregulares.
- Emisor opcional de atestaciones CI Ed25519 y job de GitHub Actions de ámbito restringido; depende del secreto y llave pública provistos por Zana.
- Pruebas adversariales de filesystem, permisos, firmas, recuperaciones, CLI y control de capacidades.
- Guías de conexión a Codex CLI y ejecución humana del E2E.

### Modificado

- Parser CLI exportable y probado, manteniendo los comandos existentes.
- Umbrales globales de cobertura: 92 % líneas, 85 % ramas y 90 % funciones, sin ningún archivo de \`src/\` por debajo de 80 % de ramas.
- README consolidado y documentación de seguridad, almacenamiento, gobernanza y roadmap sincronizada.

### Pendiente antes de liberar

- Llaves reales de operador y CI, environment protegido y atestación CI emitida por GitHub.
- Verificación de aislamiento del sistema operativo y E2E Codex por Zana.
- Revisión independiente, aprobación de PR sobre SHA exacto y decisión humana de merge.
