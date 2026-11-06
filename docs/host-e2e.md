# E2E de ZanaLLaima con un anfitrión real

**Responsable:** el operador, usando Codex CLI local. **Estado:** PASO HUMANO, no ejecutado por el cierre de desarrollo. El reporte debe permanecer \`HOST_REPORTED_UNVERIFIED\`; no equivale a auditoría de independencia.

## Preparación

1. Clonar la rama exacta del PR, registrar \`git rev-parse HEAD\` y ejecutar el CI local según README. No usar datos reales de clientes.
2. Conectar MCP siguiendo [host-codex.md](host-codex.md); capturar \`codex --version\`, \`codex mcp list\` y la lista real de herramientas (esperadas: 24).
3. Registrar el modelo y esfuerzo **visibles en la interfaz del host**, sin atribuir al MCP capacidad de verificar esa selección. Solicitar \`gpt-6-astra\` con esfuerzo \`max\`, si existe esa opción disponible. Si el host no lo ofrece, registrar la limitación y detener cualquier afirmación de conformidad con el contrato de modelo.

## Paso 1. READ: misión y capacidad incremental

Iniciar una misión con cinco tareas READ independientes en un workspace de prueba; por ejemplo:

\`\`\`json
{
  "objective": "Verificar cinco archivos de ejemplo con resultados independientes",
  "authorization": {"writesAllowed": false, "allowedPaths": []},
  "budget": {"maxActiveReads": 2, "maxWorkStarts": 7},
  "units": [
    {"id":"read-1","effect":"READ","instruction":"Verificar archivo 1 del fixture"},
    {"id":"read-2","effect":"READ","instruction":"Verificar archivo 2 del fixture"},
    {"id":"read-3","effect":"READ","instruction":"Verificar archivo 3 del fixture"},
    {"id":"read-4","effect":"READ","instruction":"Verificar archivo 4 del fixture"},
    {"id":"read-5","effect":"READ","instruction":"Verificar archivo 5 del fixture"}
  ]
}
\`\`\`

Pedir \`zana_mission_init\`, \`zana_next_batch\` y \`zana_start_batch\`. Ejecutar realmente las lecturas permitidas y completar cada paquete con token, generación y evidencia real. Tras finalizar una tarea mientras otra sigue activa, pedir nueva planificación y observar si se reserva un cupo libre. Sin subagentes disponibles, efectuar las tareas secuencialmente y declarar \`actualNativeSubagents=0\`.

**Evidencia a guardar:** SHA de repo, hora UTC, nombres de tareas, tokens redactados, leaseGeneration, estados previos y posteriores, slots reportados y contexto real observado. No guardar tokens o llaves sin redacción.

## Paso 2. WRITE: firma y efecto autorizado

Cerrar y archivar la misión READ antes de iniciar la misión WRITE. Crear un workspace temporal con un directorio \`docs/\` existente y una unidad WRITE con \`paths:["docs"]\`.

**PASO HUMANO:** generar un par Ed25519 **distinto del de CI**. Guardar la llave privada fuera de la sesión del modelo y configurar únicamente la pública en \`ZANA_OPERATOR_PUBLIC_KEY_PATH\`. Firmar un sobre de acción \`GRANT_WRITE\` para la misión exacta; el payload debe contener:

\`\`\`json
{
  "kind":"GRANT_WRITE",
  "missionId":"UUID real de la misión",
  "nonce":"UUID nuevo e irrepetible",
  "issuedAt":"ISO-8601 UTC actual",
  "expiresAt":"ISO-8601 UTC dentro de 30 minutos",
  "paths":["docs"]
}
\`\`\`

La firma Ed25519 es sobre los bytes UTF-8 de \`JSON.stringify(payload)\`, codificada en Base64 en la propiedad \`signature\` del sobre. Importar desde el CLI **fuera del contexto GPT**:

\`\`\`sh
ZANA_STATE_FILE="$HOME/.local/state/zana-llaima/e2e.json" \
ZANA_OPERATOR_PUBLIC_KEY_PATH="$HOME/.config/zana-llaima/operator-public.pem" \
node src/cli.mjs operator-import /ruta/segura/grant-firmado.json
\`\`\`

Reservar el WRITE mediante \`zana_start_batch\`. Pedir al host que intente primero una escritura directa sin MCP dentro del workspace de prueba: **debe ser denegada por el SO**, no por instrucciones del prompt. Si la escritura directa funciona, ZL-004 **no está validado operativamente**.

Para el efecto válido utilizar exclusivamente \`zana_apply_write\` con \`unitId\`, \`token\`, \`leaseGeneration\`, \`path:"docs/resultado.txt"\` y \`content\` UTF-8, opcionalmente \`expectedPreSha256\`. Comprobar el archivo y SHA posteriores y que existe un único recibo. Intentar repetir la misma operación: debe ser rechazada.

**Evidencia:** hash previo/posterior, recibo, permiso válido, rechazo de duplicado, rechazo de escritura directa, hash del archivo real.

## Paso 3. Interrupción y recuperación

En otra misión o intento descartable, reservar una READ y terminar su proceso cliente antes de completar. Dejar vencer el lease de prueba, reconectar, llamar a \`zana_recover_expired\` y después a \`zana_unit_retry\`. Debe producir un nuevo token/generación sin reutilizar recibos.

Para un WRITE incierto no repetir \`zana_apply_write\`. Registrar \`OUTCOME_UNKNOWN\` y resolver solamente mediante una acción firmada \`RECONCILE_WRITE\` del operador, usando el contenido y hash reales del archivo como evidencia.

## Paso 4. RDD de cuatro lentes

En una misión READ completada y con árbol Git limpio, abrir revisión del SHA exacto:

\`\`\`sh
git rev-parse HEAD
node src/cli.mjs review-open "$(git rev-parse HEAD)"
node src/cli.mjs review-next
node src/cli.mjs review-start
\`\`\`

Ejecutar los cuatro lentes: \`risk\`, \`reliability\`, \`resilience\` y \`readability\`. Enviar cada resultado con token, SHA y evidencia concreta. Si no hay subagentes nativos realmente disponibles, utilizar modo secuencial y registrar \`SELF_CHECK_COMPLETE_UNVERIFIED\`. No convertir cuatro respuestas del mismo contexto en una revisión independiente ni en aprobación.

## Paso 5. Reporte real y cierre

Copiar [examples/host-e2e-report.json](../examples/host-e2e-report.json), sustituir los \`null\` únicamente por observaciones verificadas y adjuntar enlaces a logs/redacciones pertinentes. Registrar modelo, esfuerzo, versión, timestamp UTC, IDs de subagentes si la UI los muestra, denegación del WRITE directo, recibos SHA, recuperación y ciclo 4R.

**PASO HUMANO:** el operador ejecuta el procedimiento, revisa evidencia sensible y commitea el reporte en la rama adecuada. ZL-018 permanece abierto hasta tener ese reporte real.

Ningún resultado E2E modifica por sí mismo las reglas de PR, genera una aprobación independiente ni autoriza un merge o deploy.

## Anexo para el operador: generar y firmar un grant WRITE fuera de Codex

**PASO HUMANO.** La llave privada se crea y se mantiene fuera de cualquier sesión del agente:

```sh
umask 077
mkdir -p "$HOME/.config/zana-llaima"
openssl genpkey -algorithm Ed25519 -out "$HOME/.config/zana-llaima/operator-private.pem"
openssl pkey -in "$HOME/.config/zana-llaima/operator-private.pem" \
  -pubout > "$HOME/.config/zana-llaima/operator-public.pem"
```

Guardar el payload JSON de `GRANT_WRITE` mostrado antes en `/ruta/segura/grant-payload.json` con el UUID real de misión, nonce único y vigencia menor a 30 minutos. Firmarlo exactamente sobre los bytes de `JSON.stringify(payload)` con Node, sin entregar la privada al modelo:

```sh
node -e '
const fs=require("node:fs"),crypto=require("node:crypto");
const payload=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const key=crypto.createPrivateKey(fs.readFileSync(process.argv[1]));
const signature=crypto.sign(null,Buffer.from(JSON.stringify(payload),"utf8"),key).toString("base64");
fs.writeFileSync(process.argv[3],JSON.stringify({payload,signature},null,2)+"\n",{mode:0o600});
' "$HOME/.config/zana-llaima/operator-private.pem" \
  /ruta/segura/grant-payload.json /ruta/segura/grant-firmado.json
```

Después importar el sobre con `node src/cli.mjs operator-import /ruta/segura/grant-firmado.json` usando el mismo `ZANA_STATE_FILE` y `ZANA_OPERATOR_PUBLIC_KEY_PATH` del servidor MCP.
