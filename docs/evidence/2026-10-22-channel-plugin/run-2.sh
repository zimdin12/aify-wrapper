#!/bin/sh
# Round 2, after review: the plugin's args differ from the user-scope server's (`--from-plugin`), and the stub applies the
# proposed producer gate (WITNESS_GATE=1). Same container setup as run.sh, output in out-2:
#   docker run --rm -v <checkout>:/pkg:ro -v <this dir>/out-2:/evidence/out node:22-bookworm sh /pkg/docs/evidence/2026-10-22-channel-plugin/run-2.sh
#   D  --channels plugin:..., plugin AND user-scope server: do both start now, and which one delivers
#   E  the development flag, plugin AND user-scope server: do both start, and which one delivers
#   F  plain claude, no route variable (a session the launcher did not start): does anything push
set -u
OUT=/evidence/out
E=/pkg/docs/evidence/2026-10-22-channel-plugin
mkdir -p "$OUT" /work /bridge /tmp/aify-local/.claude-plugin /tmp/aify-local/plugins/aify-channel/.claude-plugin
cp "$E/stub-channel.js" /bridge/claude-channel.js
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq tmux >/dev/null 2>&1
npm install -g -s @anthropic-ai/claude-code@2.1.308 >/dev/null 2>&1
claude --version > "$OUT/claude-version.txt" 2>&1
node "$E/fake-api.mjs" &
cp /pkg/plugins/aify-local/.claude-plugin/marketplace.json /tmp/aify-local/.claude-plugin/
cat > /tmp/aify-local/plugins/aify-channel/.claude-plugin/plugin.json <<'JSON'
{"name": "aify-channel", "version": "1.0.0", "description": "witness",
 "mcpServers": {"aify-comms-channel": {"command": "node", "args": ["/bridge/claude-channel.js", "--from-plugin"], "env": {"AIFY_CHANNEL_SOURCE": "plugin"}}}}
JSON
cp /tmp/aify-local/plugins/aify-channel/.claude-plugin/plugin.json "$OUT/generated-plugin.json"
FAKE_KEY="sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE-channelproofonly00"
B=ANTHROPIC_BASE_URL=http://127.0.0.1:9999
export HOME=/root/witness
mkdir -p "$HOME"
tail20=$(printf %s "$FAKE_KEY" | tail -c 20)
cat > "$HOME/.claude.json" <<JSON
{"hasCompletedOnboarding": true, "theme": "dark", "customApiKeyResponses": {"approved": ["$tail20"], "rejected": []},
 "projects": {"/work": {"hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true}}}
JSON
mkdir -p /etc/claude-code
node --input-type=module -e '
import fs from "node:fs";
import { withOurChannel } from "/pkg/lib/channel-policy.mjs";
fs.writeFileSync("/etc/claude-code/managed-settings.json", withOurChannel("").text);'
env ANTHROPIC_API_KEY=$FAKE_KEY $B claude plugin marketplace add /tmp/aify-local > "$OUT/install.txt" 2>&1
env ANTHROPIC_API_KEY=$FAKE_KEY $B claude plugin install aify-channel@aify-local >> "$OUT/install.txt" 2>&1
env ANTHROPIC_API_KEY=$FAKE_KEY $B claude mcp add --scope user aify-comms-channel -- node /bridge/claude-channel.js >> "$OUT/install.txt" 2>&1

run_case() {
  name=$1; route=$2; flags=$3; accept=${4:-}
  rm -f /tmp/aify-channel.log; : > /tmp/fake-api.log
  tmux kill-server 2>/dev/null
  tmux new-session -d -s w -x 160 -y 48 -c /work \
    "env HOME=$HOME ANTHROPIC_API_KEY=$FAKE_KEY $B WITNESS_GATE=1 $route AIFY_SERVER_URL=http://endpoint.witness:1 claude $flags; sleep 600"
  sleep 8
  tmux capture-pane -p -t w > "$OUT/$name.screen-8s.txt"
  [ -n "$accept" ] && tmux send-keys -t w Enter
  sleep 22
  tmux capture-pane -p -t w > "$OUT/$name.screen-30s.txt"
  tmux kill-server 2>/dev/null
  sleep 3
  cp /tmp/aify-channel.log "$OUT/$name.channel.log" 2>/dev/null || echo "(no channel server started)" > "$OUT/$name.channel.log"
  grep -E "envelope|POST /v1/messages" /tmp/fake-api.log | sort -u -k3 > "$OUT/$name.api-envelopes.txt"
  ps -eo pid,ppid,args | grep -E "[c]laude-channel|[c]laude " > "$OUT/$name.after-exit-processes.txt" || echo "(none left)" > "$OUT/$name.after-exit-processes.txt"
}
run_case D-plugin-route-both-configured AIFY_CHANNEL_ROUTE=plugin "--channels plugin:aify-channel@aify-local"
run_case E-dev-route-both-configured AIFY_CHANNEL_ROUTE=dev "--dangerously-load-development-channels server:aify-comms-channel" accept
run_case F-plain-claude "" ""
echo done > "$OUT/finished.txt"
