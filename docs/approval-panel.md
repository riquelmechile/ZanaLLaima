# Panel de aprobación MCP Apps

El panel permite que el operador apruebe el plan vigente y autorice una operación de creación de repositorio con una sola decisión. Diseño original: `claude/diseno-panel-aprobacion.md`. Implementación en `src/remote.mjs`; núcleo y vista en `src/approval-panel.mjs` y `src/approval-panel-view.mjs`.

## Recorrido

1. El anfitrión declara `capabilities.extensions['io.modelcontextprotocol/ui']={mimeTypes:['text/html;profile=mcp-app']}` al inicializar MCP. Si falta, `zana_project_approval_panel` devuelve `UI_UNAVAILABLE`, sin crear panel ni nonce. Sigue el flujo de `zana_plan_approval_request` y `zana_bootstrap_request` con la página del operador.
2. El modelo pide `zana_project_approval_panel` con el workspace, `expectedVersion`, propietario, nombre y visibilidad. La respuesta incluye una instrucción textual para no afirmar aprobación; `structuredContent.panel` tiene los datos visibles de la propuesta y `_meta['zana-llaima/panel']` lleva `panelId` y nonce.
3. La vista `ui://zanallaima/approval-panel-v1.html` se obtiene con `resources/read`, MIME `text/html;profile=mcp-app`, CSP sin dominios externos y borde preferido. Solo el operador pulsa Aprobar o Rechazar.
4. La vista llama a `zana_panel_decide` con `panelId`, nonce y `decision`. Un `APPROVED` autoriza el plan y la operación de bootstrap en la transacción de estado. Recién entonces la vista invoca `zana_bootstrap_execute`. Consultar `zana_bootstrap_status` para confirmar `DONE`; un resultado desconocido requiere reconciliación, no un segundo POST.

## Dos candados de seguridad

- **Visibilidad:** `zana_panel_decide` tiene `_meta.ui.visibility=['app']`, además de los alias OpenAI de compatibilidad. El SDK la deshabilita al inicializar una sesión sin la extensión UI y el despacho también responde `UI_UNAVAILABLE`.
- **Secreto:** el nonce de 256 bits es de un solo uso, asociado a panel/cliente y con vencimiento. Solo se entrega en `_meta`, nunca en `content`, `structuredContent` o la auditoría. Se omite explícitamente de los argumentos auditados para `zana_panel_decide`. La auditoría de resultado `operator_panel_approval` incluye workspace, digest, repositorio y operationId, no el nonce.

**Límite:** esta protección depende de que el host cumpla la especificación MCP Apps, oculte las herramientas app-only al modelo y no exponga `_meta` en su contexto. Un cliente que no declare la extensión no puede decidir por el panel. La negociación verificada se apoya en la extensión del cliente; no es necesario anunciar una extensión de servidor separada para registrar el recurso MCP estático.

## Verificación

`tests/remote-approval-panel.test.mjs` envía un `initialize` MCP crudo con y sin la extensión UI. Comprueba `tools/list`, `resources/read`, aislamiento del nonce, auditoría y el flujo completo contra el GitHub falso de las pruebas. Gates del proyecto: `npm run check`, `npm test`, `npm run test:coverage` y `node scripts/release-preflight.mjs`.
