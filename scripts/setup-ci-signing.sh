#!/usr/bin/env bash
# Configuración local: ejecutar solo por Zana. No mostrar llaves privadas.
set -euo pipefail
IFS=$'\n\t'
REPO='riquelmechile/ZanaLLaima'
ENVIRONMENT='ci-attestation'
PR_BRANCH='feat/gpt-native-solo-engine'
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
KEY_DIR="$HOME/.config/zana-llaima"
PRIVATE_KEY="$KEY_DIR/ci-attest-private.pem"
OPERATOR_PUBLIC="$KEY_DIR/operator-public.pem"
if [[ -n "$(printenv ZANA_OPERATOR_PUBLIC_KEY_PATH || true)" ]]; then
  OPERATOR_PUBLIC="$ZANA_OPERATOR_PUBLIC_KEY_PATH"
fi
PUBLIC_FILE="$ROOT/keys/ci-verifier.pub"
TMP_PUBLIC=''
fail() { printf 'Configuración CI rechazada: %s\n' "$*" >&2; exit 1; }
cleanup() { if [[ -n "$TMP_PUBLIC" ]]; then rm -f -- "$TMP_PUBLIC"; fi; }
trap cleanup EXIT

if [[ "${1:-}" == '--dry-run' && "$#" -eq 1 ]]; then
  printf '%s\n' \
    'SIMULACIÓN: ningún archivo, llave, secreto ni configuración GitHub será modificado.' \
    '1. Validar pública del operador y que sea distinta de la pública CI.' \
    '2. Conservar la privada CI existente o generar Ed25519 local con modo 0600.' \
    '3. Desactivar atestación y permitir main, la rama feature y refs/pull/1/merge (PR #1).' \
    '4. Cargar el secreto CI únicamente por stdin; no mostrar su contenido.' \
    '5. Publicar solo la llave pública keys/ci-verifier.pub.' \
    '6. Requerir aprobación humana antes de activar la atestación.'
  exit 0
fi
if [[ "$#" -ne 0 ]]; then fail 'Único argumento permitido: --dry-run'; fi
for program in openssl gh mktemp sha256sum chmod stat cut cmp grep mv mkdir; do
  command -v "$program" >/dev/null 2>&1 || fail "Falta comando requerido: $program"
done
[[ -f "$OPERATOR_PUBLIC" && ! -L "$OPERATOR_PUBLIC" ]] ||
  fail 'Falta llave pública válida del operador. Configurar ZANA_OPERATOR_PUBLIC_KEY_PATH.'
[[ -d "$ROOT/keys" && ! -L "$ROOT/keys" ]] ||
  fail 'Directorio keys/ inexistente o inseguro.'
# Inspección de públicas únicamente; nunca imprimir material privado.
operator_fp="$(openssl pkey -pubin -in "$OPERATOR_PUBLIC" -pubout -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)" ||
  fail 'No se pudo validar la llave pública del operador.'
[[ "$operator_fp" =~ ^[[:xdigit:]]{64}$ ]] || fail 'Huella pública del operador inválida.'
umask 077
mkdir -p -- "$KEY_DIR"
if [[ -L "$PRIVATE_KEY" ]]; then fail 'La ruta de la llave CI no puede ser symlink.'; fi
if [[ ! -e "$PRIVATE_KEY" ]]; then
  # La llave privada solo se genera en la máquina de Zana y nunca se sobrescribe.
  openssl genpkey -algorithm Ed25519 -out "$PRIVATE_KEY" >/dev/null ||
    fail 'No se pudo crear la llave CI.'
fi
[[ -f "$PRIVATE_KEY" && ! -L "$PRIVATE_KEY" ]] || fail 'Llave CI inválida.'
[[ "$(stat -c '%a' "$PRIVATE_KEY")" == '600' ]] ||
  fail 'La llave privada existente debe tener modo 0600; no se modifica automáticamente.'
TMP_PUBLIC="$(mktemp "$ROOT/keys/.ci-public.XXXXXXXX")"
chmod 0600 "$TMP_PUBLIC"
openssl pkey -in "$PRIVATE_KEY" -pubout -out "$TMP_PUBLIC" >/dev/null ||
  fail 'No se pudo derivar la llave pública CI.'
ci_fp="$(openssl pkey -pubin -in "$TMP_PUBLIC" -pubout -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)" ||
  fail 'No se pudo calcular la huella pública CI.'
[[ "$ci_fp" =~ ^[[:xdigit:]]{64}$ ]] || fail 'Huella pública CI inválida.'
[[ "$ci_fp" != "$operator_fp" ]] ||
  fail 'La llave CI coincide con la del operador: firmantes deben ser distintos.'

# Desactivar antes de configurar. No se habilita automáticamente al terminar.
gh variable set ZANA_CI_ATTESTATION_READY --repo "$REPO" --body false >/dev/null
gh api --method PUT "repos/$REPO/environments/$ENVIRONMENT" \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true' >/dev/null
policy_api="repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies"
existing="$(gh api --paginate "$policy_api" --jq '.branch_policies[].name')"
while IFS= read -r policy; do
  [[ -z "$policy" ]] && continue
  case "$policy" in
    main|feat/gpt-native-solo-engine|refs/pull/1/merge) ;;
    *) fail "Política de rama no autorizada: $policy" ;;
  esac
done <<< "$existing"
for branch in main "$PR_BRANCH" refs/pull/1/merge; do
  if ! grep -Fxq -- "$branch" <<< "$existing"; then
    gh api --method POST "$policy_api" -f "name=$branch" -f 'type=branch' >/dev/null
  fi
done
verified="$(gh api --paginate "$policy_api" --jq '.branch_policies[].name')"
for branch in main "$PR_BRANCH" refs/pull/1/merge; do
  grep -Fxq -- "$branch" <<< "$verified" ||
    fail "No se confirmó la política de rama: $branch"
done
while IFS= read -r policy; do
  [[ -z "$policy" ]] && continue
  case "$policy" in
    main|feat/gpt-native-solo-engine|refs/pull/1/merge) ;;
    *) fail "Política no autorizada tras configuración: $policy" ;;
  esac
done <<< "$verified"

# La llave privada se transmite al secreto exclusivamente por stdin.
gh secret set ZANA_CI_SIGNING_KEY --repo "$REPO" --env "$ENVIRONMENT" < "$PRIVATE_KEY" >/dev/null
chmod 0644 "$TMP_PUBLIC"
if ! cmp -s "$TMP_PUBLIC" "$PUBLIC_FILE"; then
  mv -f -- "$TMP_PUBLIC" "$PUBLIC_FILE"
  TMP_PUBLIC=''
fi
printf 'Huella SHA-256 de llave pública CI: %s\n' "$ci_fp"
printf '%s\n' \
  'Siguientes pasos:' \
  '1. Verificar reglas de aprobación humana del environment ci-attestation.' \
  '2. Commitear solo keys/ci-verifier.pub y ejecutar CI sobre el SHA nuevo.' \
  '3. Activar manualmente ZANA_CI_ATTESTATION_READY=true después de aprobar el código.' \
  '4. Comprobar artifact firmado y delivery-check; no realizar merge automático.'
