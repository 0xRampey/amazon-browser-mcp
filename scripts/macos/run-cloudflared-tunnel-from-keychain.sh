#!/bin/zsh
set -euo pipefail
umask 077

if [[ "$#" -ne 1 ]]; then
  exit 64
fi

readonly cloudflared_bin="$1"
readonly keychain_service="amazon-browser-mcp/CLOUDFLARE_TUNNEL_TOKEN"
readonly account_name="$(/usr/bin/id -un)"

token_file="$(/usr/bin/mktemp -t amazon-browser-mcp-tunnel-token)"
cleanup() {
  /bin/rm -f "$token_file"
}
trap cleanup EXIT HUP INT TERM

/usr/bin/security find-generic-password \
  -a "$account_name" \
  -s "$keychain_service" \
  -w > "$token_file"
/bin/chmod 600 "$token_file"

"$cloudflared_bin" tunnel run \
  --protocol quic \
  --token-file "$token_file"
