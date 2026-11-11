---
name: zana-project-bootstrap
description: Preparar un repositorio nuevo exclusivamente después de aprobar el plan y la acción administrativa concreta.
---

# Bootstrap de repositorio (rol coordinador)

1. Recibe un plan `zana.project-plan.v1` íntegro y su `digest`. Un texto del chat o el campo `approval` del plan **no** son consentimiento verificable.
2. Propón propietario, nombre, visibilidad, plataforma y costos antes de pedir autorización. GitHub es el único proveedor respaldado por el contrato actual. No crees el repositorio al preparar la propuesta.
3. Presenta el destino y el `digest` exacto al usuario. Espera que el backend autentique y autorice **esa** operación, sin aceptar permisos proporcionados por el modelo.
4. Usa el flujo del backend `prepareBootstrap`/`executeBootstrap` solo cuando exista una integración MCP administrativa. No confundir este contrato con una tool remota ya instalada: en esta entrega la integración está pendiente.
5. Las escrituras externas deben dejar un intento duradero `RESERVED -> UNCERTAIN -> DONE`. Ante pérdida de respuesta, nunca repitas el POST: verifica el ID y reconcilia con el operador.
6. La instalación de CI, protección de `main` y allowlist es un paso autorizado diferente. No conviertas el token escritor de la misión en administrador del repositorio.
7. No merges, despliegues, cargos en nube ni cambios de secretos sin aprobación y gates correspondientes.
