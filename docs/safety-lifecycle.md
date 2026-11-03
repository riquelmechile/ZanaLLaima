# Fase 0: seguridad funcional y recuperación

Este módulo controla un único GPT y **no ejecuta por sí solo sus cambios de archivos**. Los efectos deben ocurrir mediante herramientas reales del anfitrión. La autorización aquí implementada protege reservas, heartbeats y recibos dentro del plano de control; **no puede impedir escrituras realizadas por herramientas externas que ignoren esta política**.

## Estados y recuperación

La misión comienza en `ACTIVE` y puede finalizar en `CLOSED` (todos los trabajos completados) o `CANCELLED`. Con escrituras inciertas, cancelar produce `CANCELLING` hasta su reconciliación.

Cada trabajo recibe un token aleatorio, `leaseGeneration` creciente, `heartbeatAt` y `expiresAt`. El lease por defecto dura 300 segundos (aceptado entre 5 y 3600). El servidor persiste las transiciones dentro de una transacción SQLite con `BEGIN IMMEDIATE`.

| Situación | Estado | Acción |
| --- | --- | --- |
| Lectura expirada | `EXPIRED` | Reintento explícito, hasta tres intentos totales |
| Lectura fallida | `FAILED` | Reintento explícito, hasta tres intentos totales |
| Escritura expirada, fallida, revocada o cancelada | `OUTCOME_UNKNOWN` | **No reintentar** hasta reconciliación firmada |
| Escritura confirmada por operador | `DONE` | Conservar resultado y evidencia |
| Escritura confirmada sin efecto | `PENDING` (o `CANCELLED`) | Nueva reserva con token/generación distintos, cuando proceda |
| Misión terminada | `CLOSED` | Archivo durable y posibilidad de iniciar otra misión |

Comandos del operador o cliente MCP, según disponibilidad:

```bash
node src/cli.mjs heartbeat <unit-id> <run-token> <lease-generation> [seconds]
node src/cli.mjs recover-expired
node src/cli.mjs retry <unit-id>
node src/cli.mjs cancel
node src/cli.mjs close
node src/cli.mjs archive
node src/cli.mjs mission-history 25
```

El resultado de `start` contiene el token, la generación y el vencimiento. Al completar se puede pasar la generación como cuarto argumento posterior al archivo de resultado:

```bash
node src/cli.mjs complete <unit-id> <token> resultado.json <lease-generation>
```

El campo de generación es recomendado en todos los clientes; el token UUID ya es obligatorio y controla los intentos anteriores.

## Permisos de escritura firmados

La bandera `writesAllowed: true` en la misión es solo una **solicitud**, no una concesión. El plano de control bloquea la reserva de un trabajo `WRITE` hasta recibir una acción `GRANT_WRITE` firmada por una clave privada Ed25519 mantenida fuera de este repositorio y fuera del alcance del modelo.

El operador instala únicamente la **clave pública** en el entorno del servidor. Por ejemplo, desde una sesión humana separada:

```bash
openssl genpkey -algorithm ED25519 -out /ruta/privada/operator.key
chmod 600 /ruta/privada/operator.key
openssl pkey -in /ruta/privada/operator.key -pubout -out /ruta/publica/operator.pub.pem
```

Configura `ZANA_OPERATOR_PUBLIC_KEY_PATH=/ruta/publica/operator.pub.pem` y `ZANA_WORKSPACE_ROOT=/ruta/absoluta/del/proyecto` para el proceso que aloja el MCP. **No configures ni montes la clave privada dentro de ese proceso**, ni la guardes en Git.

Las acciones firmadas tienen esta estructura:

```json
{
  "payload": {
    "kind": "GRANT_WRITE",
    "missionId": "UUID de misión existente",
    "nonce": "UUID único de la autorización",
    "issuedAt": "2026-11-03T17:00:00.000Z",
    "expiresAt": "2026-11-03T17:10:00.000Z",
    "paths": ["docs"]
  },
  "signature": "firma Ed25519 Base64 de JSON.stringify(payload), UTF-8"
}
```

La firma se construye sobre el JSON compacto exacto de `payload` sin modificar el orden de sus claves al transportar el documento. Debe hacerse **fuera del entorno del agente** con una herramienta de firma operada por el humano. El servidor valida firma, identidad de misión, nonce no repetido, 30 minutos máximos de vigencia, alcance solicitado, expiración y revocación.

Se importa desde una terminal del operador, nunca a través de MCP:

```bash
node src/cli.mjs operator-import /ruta/autorizacion-firmada.json
node src/cli.mjs authorization-status
```

Para revocar se firma una acción `REVOKE_WRITE` con `grantId` igual al `nonce` de la autorización original, además de nuevos `nonce`, `issuedAt`, `expiresAt` y `missionId`. La revocación convierte en `OUTCOME_UNKNOWN` cualquier escritura en curso; no permite que el modelo declare su resultado.

Para reconciliar se firma `RECONCILE_WRITE` con `unitId`, `token`, `leaseGeneration`, `decision` (`CONFIRMED_DONE` o `CONFIRMED_NO_EFFECT`) y una lista `evidence` comprobada por el operador. Solo una acción nueva, con nonce único y firma válida, puede desbloquear la escritura.

## Límite de archivos

Antes de reservar un `WRITE`, el plano de control comprueba que las rutas sean relativas al directorio absoluto `ZANA_WORKSPACE_ROOT`, correspondan al alcance firmado y no atraviesen symlinks existentes. **Es una inspección en el momento de reservar**, no una operación de escritura atómica ni una defensa completa contra TOCTOU. Un ejecutor integrado debe comprobar permisos y resolver rutas de forma segura en el momento de cada mutación, preferentemente mediante descriptores de directorio aislados.

Un anfitrión GPT que disponga de acceso directo a otros editores o APIs podría ignorar esa puerta de control. Sin integración de ese ejecutor y prueba E2E, no atribuir capacidad de protección total a la cuenta.

## Gate de fase y verificación

Las pruebas automatizadas cubren expiración y heartbeat, doble token y generación, reintento limitado, permisos sin firma, firma inválida, grant revocado, escritura fallida o interrumpida, reconciliación explícita, symlink, cierre/archivo y reinicio. El sistema no reintenta silenciosamente un `WRITE` incierto.

Las pruebas no demuestran la selección efectiva del modelo ni la creación real de subagentes ni auditan editores externos. Tampoco autorizan merge o despliegue. Conserva los resultados exactos de CI y la aprobación humana para cualquier entrega.
