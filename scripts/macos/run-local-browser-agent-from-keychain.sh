#!/bin/zsh
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  exit 64
fi

readonly bun_bin="$1"
readonly repository="$2"
readonly keychain_service="amazon-browser-mcp/LOCAL_BROWSER_AGENT_SECRET"
readonly account_name="$(/usr/bin/id -un)"

secret="$(
  /usr/bin/security find-generic-password \
    -a "$account_name" \
    -s "$keychain_service" \
    -w
)"
if [[ "${#secret}" -lt 32 ]]; then
  unset secret
  exit 78
fi

export LOCAL_BROWSER_AGENT_SECRET="$secret"
export LOCAL_BROWSER_AGENT_PORT="43218"
unset secret

cd "$repository"
exec "$bun_bin" "$repository/scripts/local-browser-agent.ts" serve
