#!/bin/sh
# What a Claude Code plugin channel does, for the facts the channel-plugin plan rests on. In a throwaway node:22-bookworm:
#   docker run --rm -v <checkout>:/pkg:ro -v <this dir>/out:/evidence/out node:22-bookworm sh /pkg/docs/evidence/2026-10-22-channel-plugin/run.sh
# Claude Code 2.1.308 from npm; the API key is a fake string and ANTHROPIC_BASE_URL is fake-api.mjs in the container.
#
# The plugin is generated the way the installer would (an absolute path to the channel script, no shim), with the
# plugin, its server key and the server's own serverInfo name all different. The managed policy comes from
# lib/channel-policy.mjs's merge. Route answers are lib/channel-route-cli.mjs against the files Claude wrote.
#   A  --channels plugin:..., plugin only           which name the envelope carries; whether the launcher's env reaches it;
#                                                    whether the server's parent is claude itself
#   B  --channels plugin:..., plugin AND a user-scope aify-comms-channel server: does each start, which is delivered
#   C  the development flag naming the user-scope server, plugin still enabled: does the plugin's server start anyway
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
 "mcpServers": {"aify-comms-channel": {"command": "node", "args": ["/bridge/claude-channel.js"], "env": {"AIFY_CHANNEL_SOURCE": "plugin"}}}}
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
route() { node /pkg/lib/channel-route-cli.mjs > "$OUT/route-$1.txt" 2>&1; }

route 1-nothing
mkdir -p /etc/claude-code
printf '%s' '{"model":"opus","allowedChannelPlugins":[{"marketplace":"m","plugin":"other"}]}' > /etc/claude-code/managed-settings.json
node --input-type=module -e '
import fs from "node:fs";
import { withOurChannel } from "/pkg/lib/channel-policy.mjs";
const f = "/etc/claude-code/managed-settings.json";
fs.writeFileSync(f, withOurChannel(fs.readFileSync(f, "utf8")).text);'
cp /etc/claude-code/managed-settings.json "$OUT/managed-settings.json"
route 2-policy-only
env ANTHROPIC_API_KEY=$FAKE_KEY $B claude plugin marketplace add /tmp/aify-local > "$OUT/install.txt" 2>&1
env ANTHROPIC_API_KEY=$FAKE_KEY $B claude plugin install aify-channel@aify-local >> "$OUT/install.txt" 2>&1
cp "$HOME/.claude/plugins/installed_plugins.json" "$OUT/installed_plugins.json" 2>/dev/null || echo "(absent)" > "$OUT/installed_plugins.json"
cp "$HOME/.claude/settings.json" "$OUT/settings.json" 2>/dev/null || echo "(absent)" > "$OUT/settings.json"
route 3-installed

run_case() {
  name=$1; flags=$2; accept=${3:-}
  rm -f /tmp/aify-channel.log; : > /tmp/fake-api.log
  tmux kill-server 2>/dev/null
  tmux new-session -d -s w -x 160 -y 48 -c /work \
    "env HOME=$HOME ANTHROPIC_API_KEY=$FAKE_KEY $B AIFY_CHANNEL_ROUTE=$name AIFY_SERVER_URL=http://endpoint.witness:1 claude $flags; sleep 600"
  sleep 8
  tmux capture-pane -p -t w > "$OUT/$name.screen-8s.txt"
  # The development flag's dialog waits with option 1 selected; Enter accepts it, as aify-comms' console rule does.
  [ -n "$accept" ] && tmux send-keys -t w Enter
  sleep 22
  tmux capture-pane -p -t w > "$OUT/$name.screen-30s.txt"
  tmux kill-server 2>/dev/null
  sleep 3
  cp /tmp/aify-channel.log "$OUT/$name.channel.log" 2>/dev/null || echo "(no channel server started)" > "$OUT/$name.channel.log"
  grep -E "envelope|POST /v1/messages" /tmp/fake-api.log | sort -u -k3 > "$OUT/$name.api-envelopes.txt"
  ps -eo pid,ppid,args | grep -E "claude-channel|[c]laude " > "$OUT/$name.after-exit-processes.txt" || echo "(none left)" > "$OUT/$name.after-exit-processes.txt"
}

run_case A-plugin-only "--channels plugin:aify-channel@aify-local"
# The user-scope server the development route loads today, added as aify-comms' installer adds it.
env ANTHROPIC_API_KEY=$FAKE_KEY $B claude mcp add --scope user aify-comms-channel -- node /bridge/claude-channel.js > "$OUT/mcp-add.txt" 2>&1
route 4-with-user-scope-server
run_case B-plugin-and-user-scope "--channels plugin:aify-channel@aify-local"
run_case C-dev-flag-plugin-enabled "--dangerously-load-development-channels server:aify-comms-channel" accept
tmux kill-server 2>/dev/null
echo done > "$OUT/finished.txt"
