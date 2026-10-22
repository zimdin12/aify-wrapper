#!/bin/sh
# Round 3: the REAL aify-comms channel (both entries, with the producer gate) in a real Claude Code 2.1.308, against a
# stand-in service, plus controls with the gate broken. In a throwaway node:22-bookworm:
#   docker run --rm -v <wrapper checkout>:/pkg:ro -v <comms checkout>/mcp/stdio:/bridge-src:ro \
#     -v <this dir>/out-3:/evidence/out node:22-bookworm sh /pkg/docs/evidence/2026-10-22-channel-plugin/run-3.sh
# The fake API logs the <channel> envelopes the model receives; fake-service.mjs logs every request by port: the
# user-scope server is configured with :9001, the plugin's server inherits :9002. The plugin is rendered and installed
# by lib/channel-plugin.mjs's renderMarketplace, the policy by lib/channel-policy.mjs's merge.
#
# Per case, named observables: which processes started (before any dedup), each port's claims, accepted claim, liveness
# beats and delivered receipts, the runtime markers by pid, and the envelope that carries the claimed message id.
set -u
OUT=/evidence/out
E=/pkg/docs/evidence/2026-10-22-channel-plugin
mkdir -p "$OUT" /work /tmp/aify
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq tmux procps >/dev/null 2>&1
npm install -g -s @anthropic-ai/claude-code@2.1.308 >/dev/null 2>&1
claude --version > "$OUT/claude-version.txt" 2>&1
node "$E/fake-api.mjs" &
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

# A bridge per variant, copied from the comms checkout; the controls edit their copy only.
bridge() { rm -rf "/bridges/$1"; mkdir -p /bridges; cp -r /bridge-src "/bridges/$1"; }
bridge real
bridge gate-deleted
sed -i 's/return Boolean(fromPlugin) === (route === PLUGIN_ROUTE);/return true;/' /bridges/gate-deleted/channel-producer.mjs
bridge gate-inverted
sed -i 's/return Boolean(fromPlugin) === (route === PLUGIN_ROUTE);/return Boolean(fromPlugin) !== (route === PLUGIN_ROUTE);/' /bridges/gate-inverted/channel-producer.mjs
grep -n "return " /bridges/*/channel-producer.mjs > "$OUT/bridge-variants.txt"

# Install the plugin for one bridge and point the user-scope server at the same bridge, as both installers would.
install_for() {
  b=/bridges/$1
  rm -rf "$HOME/.aify/claude-plugins"
  node --input-type=module -e "
import fs from 'node:fs'; import path from 'node:path';
import { marketplaceDir, renderMarketplace } from '/pkg/lib/channel-plugin.mjs';
const dir = marketplaceDir(process.env.HOME);
for (const [rel, text] of Object.entries(renderMarketplace('$b'))) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }"
  env ANTHROPIC_API_KEY=$FAKE_KEY $B claude plugin uninstall aify-channel@aify-local >/dev/null 2>&1
  env ANTHROPIC_API_KEY=$FAKE_KEY $B claude plugin marketplace remove aify-local >/dev/null 2>&1
  env ANTHROPIC_API_KEY=$FAKE_KEY $B claude plugin marketplace add "$HOME/.aify/claude-plugins/aify-local" > "$OUT/install-$1.txt" 2>&1
  env ANTHROPIC_API_KEY=$FAKE_KEY $B claude plugin install aify-channel@aify-local >> "$OUT/install-$1.txt" 2>&1
  env ANTHROPIC_API_KEY=$FAKE_KEY $B claude mcp remove --scope user aify-comms-channel >/dev/null 2>&1
  env ANTHROPIC_API_KEY=$FAKE_KEY $B claude mcp add --scope user aify-comms-channel -e AIFY_SERVER_URL=http://127.0.0.1:9001 \
    -e CLAUDE_MCP_SERVER_URL=http://127.0.0.1:9001 -- node "$b/claude-channel.js" >> "$OUT/install-$1.txt" 2>&1
  cp "$HOME/.aify/claude-plugins/aify-local/plugins/aify-channel/.claude-plugin/plugin.json" "$OUT/plugin-$1.json"
}

run_case() {
  name=$1; route=$2; flags=$3; accept=${4:-}
  rm -rf /tmp/aify /tmp/state; mkdir -p /tmp/aify /tmp/state
  : > /tmp/fake-api.log; rm -f /tmp/fake-service.jsonl
  pkill -f fake-service.mjs; sleep 1
  node "$E/fake-service.mjs" "$name-msg" &
  sleep 1
  tmux kill-server 2>/dev/null
  tmux new-session -d -s w -x 160 -y 48 -c /work \
    "env HOME=$HOME TEMP=/tmp/aify XDG_STATE_HOME=/tmp/state AIFY_CLAIM_WAIT_MS=0 ANTHROPIC_API_KEY=$FAKE_KEY $B AIFY_CHANNEL_ROUTE=$route AIFY_SERVER_URL=http://127.0.0.1:9002 CLAUDE_MCP_SERVER_URL=http://127.0.0.1:9002 claude $flags; sleep 600"
  sleep 8
  [ -n "$accept" ] && tmux send-keys -t w Enter && sleep 3
  # The agent binding, as aify-comms' MCP bridge writes it on register: keyed by Claude's pid.
  cpid=$(pgrep -f "^claude " | head -1)
  printf '{"agentId":"witness-agent","pid":%s}' "$cpid" > "/tmp/aify/aify-agent-$cpid"
  ps -eo pid,ppid,args | grep -E "[c]laude-channel" > "$OUT/$name.processes.txt"
  sleep 25
  tmux capture-pane -p -t w > "$OUT/$name.screen.txt"
  for m in /tmp/state/aify-comms/runtime-markers/*; do [ -f "$m" ] && node -e 'const m=require(process.argv[1]);const c=require("fs").readFileSync(`/proc/${m.pid}/cmdline`,"utf8").split("\0").join(" ");console.log(`marker pid=${m.pid} parentPid=${m.parentPid} runs: ${c}`)' "$m"; done > "$OUT/$name.markers.txt" 2>&1
  tmux kill-server 2>/dev/null
  sleep 3
  cp /tmp/fake-service.jsonl "$OUT/$name.service.jsonl" 2>/dev/null || : > "$OUT/$name.service.jsonl"
  grep -E "envelope" /tmp/fake-api.log | sort -u -k3 > "$OUT/$name.envelopes.txt"
  ps -eo pid,args | grep -E "[c]laude-channel" > "$OUT/$name.after-exit.txt" || echo "(none left)" > "$OUT/$name.after-exit.txt"
  node "$E/summarize.mjs" "$OUT" "$name" "$name-msg" >> "$OUT/summary.txt"
}

install_for real
run_case real-plugin-route plugin "--channels plugin:aify-channel@aify-local"
run_case real-dev-route dev "--dangerously-load-development-channels server:aify-comms-channel" accept
install_for gate-deleted
run_case control-gate-deleted plugin "--channels plugin:aify-channel@aify-local"
install_for gate-inverted
run_case control-gate-inverted plugin "--channels plugin:aify-channel@aify-local"

# The launcher's guard against a bridge that cannot run the gate: the route it would take, from Claude's real files.
#   real              the comms checkout as it is
#   downgrade         the plugin entry gone, as an older bridge has none
#   partial           claude-channel.js without the declaration beside a plugin entry
route_for() {
  install_for "$1"
  cd /work
  AIFY_CHANNEL_SERVICE=aify-comms AIFY_BRIDGE_DIR="/bridges/$1" node /pkg/lib/channel-route-cli.mjs > "$OUT/route-$1.txt" 2>&1
}
route_for real
bridge downgrade
rm /bridges/downgrade/claude-channel-plugin.mjs
route_for downgrade
bridge partial
sed -i 's/^export const CHANNEL_PRODUCER_GATE = 1;$/\/\/ declaration removed/' /bridges/partial/claude-channel.js
route_for partial
echo done > "$OUT/finished.txt"
