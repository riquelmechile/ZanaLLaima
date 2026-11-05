# Deploy del modo remoto (zana-main)

**El deploy lo hace el operador.** Ningún agente despliega, crea tokens ni edita el archivo de entorno. Esta guía es para ZanaLLaima 0.6.0 en el servidor de Oracle `zana-main`, con `systemd --user`, Cloudflare tunnel y el listener solo en loopback IPv4 (`ZANA_HTTP_PORT`, 8787 por defecto).

## 1. Código y dependencias

```sh
git clone https://github.com/riquelmechile/ZanaLLaima ~/zanallaima
cd ~/zanallaima
git checkout <SHA revisado>
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

Node.js ≥22.16.

## 2. Tokens (solo en el servidor)

1. **Autor:** PAT fine-grained de `riquelmechile`, limitado a los repos administrados, con permisos *Contents*, *Pull requests*, *Actions*, *Checks* (lectura y escritura) y *Metadata* (lectura). **Sin Administration**, sin Secrets, sin Workflows. Va en `ZANA_DOWNSTREAM_GITHUB_TOKEN` y lo usan el downstream, `zana_checks_*` y `zana_merge`.
2. **Revisora:** token de `sebastianriquelme95-max` con *Pull requests* y *Commit statuses* de escritura en los mismos repos. Va en `ZANA_REVIEWER_TOKEN`. Esta cuenta no debe tener commits en los PR que revisa (si los tiene, `zana_delivery_status` da `REVIEWER_IS_AUTHOR`).
3. **Consentimiento OAuth:** una clave aleatoria de 32+ caracteres en `ZANA_OAUTH_CONSENT_PASSWORD`.

```sh
mkdir -p ~/.config/zanallaima && chmod 700 ~/.config/zanallaima
cp deploy/zanallaima.env.example ~/.config/zanallaima/zanallaima.env
chmod 600 ~/.config/zanallaima/zanallaima.env
# editar los valores con un editor local; nunca en el repo ni en un chat
```

Completar también `ZANA_STATE_FILE` (por ejemplo `~/.local/share/zanallaima/state.json`), `ZANA_OAUTH_DB` y `ZANA_GITHUB_REPOS` (`owner/repo` separados por coma).

## 3. Servicio `systemd --user`

```sh
mkdir -p ~/.config/systemd/user
cp deploy/zanallaima.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zanallaima
loginctl enable-linger "$USER"
curl -4 -s http://localhost:8787/health
```

`/health` responde `{"status":"ok","name":"zana-llaima","mode":"remote",...}`. El proceso escucha solo en loopback IPv4; por eso `curl -4`.

## 4. Cloudflare tunnel

Agregar a la configuración del túnel (ejemplo en `deploy/cloudflared-zanallaima.yml.example`) el hostname `zanallaima.quintoestado.com` hacia el servicio de loopback IPv4 en el puerto 8787 (tal como está escrito en el ejemplo; no usar `localhost`, que puede resolver a IPv6) y reiniciar `cloudflared`. Comprobar `https://zanallaima.quintoestado.com/health` y que `https://zanallaima.quintoestado.com/mcp` sin token responde `401` con `WWW-Authenticate`.

## 5. Alta de las cuentas de Zana (registro cerrado)

1. Abrir la ventana de alta en el servidor: `node src/cli.mjs remote-enroll 15` (1 a 60 minutos).
2. En la app de ChatGPT, agregar el conector con la URL `https://zanallaima.quintoestado.com/mcp`. En la página de consentimiento: comprobar que la iniciaste tú, escribir la etiqueta del host (por ejemplo `zana-chatgpt`) y la clave del operador.
3. Repetir con cada cuenta de Zana que deba entrar.
4. Cerrar: `node src/cli.mjs remote-enroll-close`. Fuera de la ventana, `/register`, `/authorize` y el consentimiento se rechazan; las conexiones aprobadas siguen funcionando.
5. Ver y revocar: `node src/cli.mjs remote-clients` y `node src/cli.mjs remote-revoke <clientId>`.

## 6. Repos administrados

Cada repo de `ZANA_GITHUB_REPOS` necesita el workflow de checks (`docs/checks-workflow.md`), que **agrega el operador**, y protección de `main` con checks requeridos y review requerida.

## 7. Operación

- Auditoría: `node src/cli.mjs remote-audit [limite] [missionId]`.
- Merge del operador: `node src/cli.mjs remote-merge <missionId>` (mismas condiciones que `zana_merge`).
- Respaldo y restore de la DB de misiones: igual que en stdio (`docs/sqlite-storage.md`). El ledger OAuth (`ZANA_OAUTH_DB`) es un archivo aparte: respaldarlo junto a la DB; un restore de misiones no lo toca.
- Logs: `journalctl --user -u zanallaima`. Nunca contienen tokens.
- Rollback: `git checkout <SHA anterior>`, `npm ci`, `systemctl --user restart zanallaima`. La DB v7 no se puede abrir con una versión que solo entiende v6: respaldarla antes de subir de versión.
