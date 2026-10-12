#!/usr/bin/env bash
#
# Run IntentLink locally, end to end.
#
#   ./scripts/try-it.sh build     build everything
#   ./scripts/try-it.sh test      every test, no API key needed
#   ./scripts/try-it.sh compile   recording -> workflow -> policy  (needs a key)
#   ./scripts/try-it.sh policy    start the policy service and poke it with curl
#   ./scripts/try-it.sh loop      the full agent loop, including a real block
#   ./scripts/try-it.sh extension print how to load the extension in Chrome
#
set -euo pipefail
set +m          # no job-control chatter when the test server is reaped
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die()  { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

need_key() {
  [ -f .env ] || die "No .env. Copy .env.example and add GOOGLE_API_KEY."
  grep -q '^GOOGLE_API_KEY=.\+' .env || die "GOOGLE_API_KEY is empty in .env"
}

cmd_build() {
  bold "Building"
  npm install --silent
  npm run build --workspaces --if-present
  ( cd apps/extension && npm run build )
  echo "Built. Extension bundle: apps/extension/dist"
}

cmd_test() {
  bold "TypeScript"
  npm test
  bold "Python (agent)"
  [ -d apps/agent/.venv ] || die "No venv. See apps/agent/README.md"
  ( cd apps/agent && set -a && . "$ROOT/.env" 2>/dev/null; set +a; .venv/bin/python -m pytest -q )
}

cmd_compile() {
  need_key
  bold "Compiling a recorded demonstration, then boundaries written in English"
  echo "This calls Gemini twice. Watch for:"
  echo "  - the channel name becoming a PARAMETER"
  echo "  - \"private\" staying a LITERAL (a team convention, not data)"
  echo "  - priority carrying a CONDITION on severity, inferred from one example"
  ( cd packages/compiler && node --env-file-if-exists="$ROOT/.env" scripts/demo.mjs )
}

cmd_policy() {
  local secret; secret=$(openssl rand -hex 32)
  local port; port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  bold "Policy service on :$port"
  # Output goes to a log rather than inherited stdout: a backgrounded process
  # holding the pipe open means a caller piping this script never sees it end.
  SERVICE_LOG=$(mktemp)
  INTENTLINK_TOKEN_SECRET="$secret" PORT="$port" node apps/api/dist/server.js >"$SERVICE_LOG" 2>&1 &
  SERVICE_PID=$!
  trap 'kill "${SERVICE_PID:-}" 2>/dev/null || true; wait "${SERVICE_PID:-}" 2>/dev/null || true; rm -f "${SERVICE_LOG:-}"' EXIT
  sleep 1.5
  kill -0 "$SERVICE_PID" 2>/dev/null || { cat "$SERVICE_LOG"; die "policy service did not start"; }

  local policy=packages/schema/fixtures/policy.incident-channel.json
  local pid_policy=c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f
  local exec_id=11111111-1111-4111-8111-111111111111

  curl -sS -X PUT localhost:$port/v1/policies -H 'content-type: application/json' --data @"$policy" >/dev/null
  curl -sS -X POST localhost:$port/v1/executions -H 'content-type: application/json' \
    -d "{\"executionId\":\"$exec_id\",\"policyId\":\"$pid_policy\"}" >/dev/null

  ask() {
    printf '\n  %s\n' "$1"
    curl -sS -X POST localhost:$port/v1/decide -H 'content-type: application/json' -d "$2" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print("    ->", d["outcome"], "|", d.get("sourceText") or d["reason"])'
  }
  act() { printf '{"policyId":"%s","receiver":"platform@acme.com","action":{"executionId":"%s","stepId":"s1","verb":"%s","object":"%s","args":%s,"origin":"https://acme.slack.com","path":"/admin/channels"}}' "$pid_policy" "$exec_id" "$1" "$2" "$3"; }

  bold "Asking the engine what it permits"
  ask "create the incident channel"          "$(act create_channel channel '{}')"
  ask "set the channel topic"                "$(act set_topic channel '{}')"
  ask "open the tracking issue on INC"       "$(act create_issue issue '{"project":"INC"}')"
  ask "open an issue on a DIFFERENT board"   "$(act create_issue issue '{"project":"FINANCE"}')"
  ask "invite someone inside the company"    "$(act invite_user '' '{"email":"sre@acme.com"}')"
  ask "invite someone OUTSIDE the company"   "$(act invite_user '' '{"email":"contractor@other.com"}')"
  ask "delete a channel"                     "$(act delete_channel '' '{}')"
  ask "page the on-call (needs approval)"    "$(act send_page pager '{}')"

  printf '\n  The audit for that execution:\n'
  curl -sS "localhost:$port/v1/audit/$exec_id" | python3 -c '
import json, sys
d = json.load(sys.stdin)
s = d["summary"]
print("    {} blocked, {} approvals requested".format(s["blocked"], s["approvals"]))
print("    (0 executed: these were decisions only, no token was redeemed)")
print("    hash chain verifies:", d["chain"]["ok"])
for b in s["boundariesHit"]:
    print("    boundary hit:", b)
'
}

cmd_loop() {
  need_key
  bold "The full loop: agent proposes, engine decides, nothing acts without a token"
  ( cd apps/agent && set -a && . "$ROOT/.env"; set +a
    .venv/bin/python -m pytest tests/test_loop.py -q )
}

cmd_extension() {
  bold "Loading the extension"
  cat <<EOF

  1. Build it:        ./scripts/try-it.sh build
  2. Open Chrome at:  chrome://extensions
  3. Turn on          Developer mode  (top right)
  4. Click            Load unpacked
  5. Choose           $ROOT/apps/extension/dist
  6. Pin IntentLink, open any site, click the icon to open the side panel
  7. Press Record and do something - a few clicks and a form field

  What to look for in the panel:
    - each step described in words, with the descriptor underneath
    - "0 coordinates captured" - the claim, stated as a live number
    - a password or API-key field showing "value withheld"

EOF
}

case "${1:-}" in
  build)     cmd_build ;;
  test)      cmd_test ;;
  compile)   cmd_compile ;;
  policy)    cmd_policy ;;
  loop)      cmd_loop ;;
  extension) cmd_extension ;;
  *) sed -n '3,11p' "$0" | cut -c3- ;;
esac
