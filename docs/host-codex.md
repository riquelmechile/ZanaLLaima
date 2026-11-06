# Integración local con Codex CLI (preparación de ZL-018)

**Estado:** guía para la prueba humana. No se ha confirmado que una sesión Codex real haya utilizado este MCP, ni su modelo o esfuerzo. El motor es autónomo y no requiere APIs de inferencia.

## 1. Preparar el entorno

En Linux, con Node 22.16+ y Codex CLI instalado:

\`\`\`sh
cd /ruta/a/ZanaLLaima
git rev-parse HEAD
npm ci --ignore-scripts --no-audit --no-fund
npm run check
mkdir -p "$HOME/.local/state/zana-llaima" "$HOME/zana-e2e-workspace"
\`\`\`

Para evitar mezclar pruebas con datos productivos, usar un directorio E2E temporal y un archivo de estado separado. No permitir que un modelo lea claves privadas del operador o del emisor CI.

## 2. Agregar el servidor MCP stdio

Comando de configuración del **Codex CLI local**:

\`\`\`sh
codex mcp add zana-llaima \
  --env ZANA_STATE_FILE="$HOME/.local/state/zana-llaima/e2e.json" \
  --env ZANA_WORKSPACE_ROOT="$HOME/zana-e2e-workspace" \
  --env ZANA_REVIEW_REPO="/ruta/a/ZanaLLaima" \
  --env ZANA_REVIEW_TARGET_REF="refs/heads/main" \
  --env ZANA_OPERATOR_PUBLIC_KEY_PATH="$HOME/.config/zana-llaima/operator-public.pem" \
  -- node /ruta/a/ZanaLLaima/src/mcp.mjs

codex mcp list
codex mcp get zana-llaima
\`\`\`

\`--env\` configura el proceso servidor, no el modelo o esfuerzo del anfitrión. El servidor ofrece 24 herramientas MCP; comprobar \`zana_profile\`, \`zana_capability_status\` y \`zana_storage_status\`.

Se puede configurar también en \`~/.codex/config.toml\` mediante \`[mcp_servers.zana-llaima]\`, \`command="node"\`, \`args=["/ruta/a/ZanaLLaima/src/mcp.mjs"]\` y \`env={...}\`.

Referencia de la interfaz de CLI: https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs

## 3. Seguridad del ejecutor

**La configuración simple anterior no es aislamiento de SO.** Si Codex y el MCP corren con el mismo usuario y ambos pueden escribir en el workspace, Codex puede omitir \`zana_apply_write\`. Esto impide afirmar que ZL-004 está verificado operacionalmente.

Configuración recomendada para la prueba de seguridad:

- Propietario del workspace: un usuario de SO exclusivo para el proceso MCP, con permisos mínimos.
- Usuario de Codex: acceso de lectura a los archivos y permisos insuficientes para escribir por shell o editor.
- Lanzador MCP: autorizado explícitamente a ejecutar \`node .../src/mcp.mjs\` como usuario propietario, sin exponer el private key del operador.
- Alternativamente, Codex dentro de un contenedor con workspace montado \`:ro\` y proceso MCP separado con acceso WRITE acotado.
- Verificar con una prueba negativa de escritura directa denegada por el SO, además de la escritura mediante MCP; registrar ambas.

No ejecutar la prueba contra el repositorio de trabajo que se pretende proteger. Usar un workspace de E2E independiente.

## 4. Qué debe registrar el operador

En la UI/CLI del anfitrión, anotar versión de Codex, modelo y esfuerzo **tal como aparecen**, hora UTC, herramientas listadas y resultado de cada operación. Si no se observa un subagente nativo real, registrar \`null\` y declarar modo secuencial, no inventar IDs.

El reporte completo se define en [host-e2e.md](host-e2e.md). Los valores de modelo, esfuerzo, recibos y subagentes son \`HOST_REPORTED_UNVERIFIED\` hasta que una fuente independiente los compruebe.

## Fuera de alcance

**ChatGPT web no se conecta a stdio.** Para la app de ChatGPT existe el modo remoto de ZanaLLaima 0.6.0: ver [deploy-remote.md](deploy-remote.md) y [host-e2e-remote.md](host-e2e-remote.md).
