---
name: zana-project-bootstrap
description: Preparar un repositorio nuevo exclusivamente después de aprobar el plan y la acción administrativa concreta.
---

# Bootstrap de repositorio (rol coordinador)

1. Recibe un plan `zana.project-plan.v1` íntegro y su `digest`. Un texto del chat o el campo `approval` del plan **no** son consentimiento verificable.
2. Propón propietario, nombre, visibilidad, plataforma y costos antes de pedir autorización. GitHub es el único proveedor respaldado por el contrato actual. No crees el repositorio al preparar la propuesta.
3. Presenta el destino y el `digest` exacto al usuario. Espera que el backend autentique y autorice **esa** operación, sin aceptar permisos proporcionados por el modelo.
4. **Si el cliente negoció MCP Apps**, abre `zana_project_approval_panel` con `workspaceId`, versión, dueño, nombre y visibilidad. El panel muestra el plan y destino; el operador aprueba el plan y la operación en un solo clic. `zana_panel_decide` es exclusiva de la vista y no la llama el modelo. Tras `APPROVED`, la vista llama `zana_bootstrap_execute`. No anuncies aprobado ni creado hasta que el panel confirme o `zana_bootstrap_status` diga `DONE`.

   **Sin panel** (el servidor responde `UI_UNAVAILABLE`), usa el flujo vigente: con el plan aprobado (`zana_plan_approval_status` en `APPROVED`), pide la autorización con `zana_bootstrap_request` (borrador, versión vigente, dueño, nombre y visibilidad) y entrega al usuario el `authorization.approvalUrl` tal cual. Solo el operador autoriza, en esa página y con su contraseña; nunca la pidas en el chat. Consulta con `zana_bootstrap_status`. La autorización es de ese intento exacto, vence a las 24 horas y no vale mientras el plan vigente no sea el aprobado; si el operador revoca la aprobación del plan, hay que pedirla de nuevo.
5. Con la autorización en `APPROVED`, crea el repositorio con `zana_bootstrap_execute`. Cada autorización vale para un solo intento. Si responde `CREATE_REJECTED`, explica la causa (`lastError`) y pide una autorización nueva con `zana_bootstrap_request`. Si responde `OUTCOME_UNKNOWN` o `RECONCILIATION_REQUIRED`, no reintentes: espera un minuto y usa `zana_bootstrap_reconcile` (antes de eso responde `RECONCILE_TOO_EARLY`). Solo se crean repositorios de la cuenta del token, no de organizaciones. Solo di que el repositorio existe cuando el estado sea `DONE` y `created` traiga su nombre. El repositorio nace sin CI, sin revisora y sin protección de rama.
6. Las escrituras externas deben dejar un intento duradero `RESERVED -> UNCERTAIN -> DONE`. Ante pérdida de respuesta, nunca repitas el POST: verifica el ID y reconcilia con el operador.
7. La instalación de CI, protección de `main` y allowlist es un paso autorizado diferente. No conviertas el token escritor de la misión en administrador del repositorio.
8. No merges, despliegues, cargos en nube ni cambios de secretos sin aprobación y gates correspondientes.
## Preparación administrativa automática

Con `ZANA_GITHUB_FULL_ACCESS=true`, tras crear o adoptar el repositorio usa `zana_github_request` para: escribir `.github/workflows/zana-checks.yml` desde `docs/checks-workflow.md` adaptada al lenguaje (solo `workflow_dispatch`, `permissions: contents: read`, sin secretos); invitar a `ZANA_REVIEWER_LOGIN` con push; aceptar la invitación con `identity: reviewer`; proteger la rama default con PR, una aprobación, obsoletas descartadas, check `zana-checks` y conversaciones resueltas. Verifica cada efecto con GET antes de lanzar misiones.
