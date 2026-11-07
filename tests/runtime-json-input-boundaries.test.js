// New coverage: raw runtime override refusal, first command word, and exact JSON/word boundaries at the native stub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launch } from './launch-to-a-stub-runtime.mjs';
const CAPTURE=`#!/bin/bash
env > "$STUB_RUNTIME_ENV"
printf '%s\\n' "$@" > "$STUB_RUNTIME_ENV.args"
mkdir -p "$HOME/.aify/sessions/test-agent"
while [ "$#" -gt 0 ]; do
 if [ "$1" = --mcp-config ]; then cp "$2" "$HOME/.aify/sessions/test-agent/captured-mcp.json"; fi
 shift
done
exit 0
`;
function strict(env={},edit){return launch('claude',[],{cwd:'work',env:{HARNESS_IDENTITY:'test-agent',AIFY_CLAUDE_STRICT_MCP:'1',...env},edit,
 bridgeFiles:{'claude-channel.js':'// owned presence only\n'},files:{'stubs/claude':CAPTURE,'bridge/Program Files/claude-channel.js':'// owned presence only\n'}});}
const B=String.fromCharCode(92);
for(const client of ['claude','codex','hermes','pi'])for(const [name,value]of [['quote','http://127.0.0.2:1/"bad'],['backslash',`http://127.0.0.2:1/${B}bad`],['newline','http://127.0.0.2:1/\nbad'],['C1','http://127.0.0.2:1/'+String.fromCharCode(133)]])test(`${client} refuses runtime endpoint ${name} even on --check`,()=>{
 const result=launch(client,['--check'],{cwd:'work',env:{HARNESS_ENDPOINT:value}});
 assert.equal(result.run.status,78,result.run.stderr);assert.match(result.run.stderr,/HARNESS_ENDPOINT/);assert.deepEqual(result.started,{});assert.deepEqual(result.asked,[]);
});
for(const [name,value]of [['first word backslash',`C:${B}bin${B}node server.js`],['first word quote','no"de server.js'],['argument backslash',`node C:${B}bridge${B}server.js`],['argument quote','node bad"arg'],['suffix newline','node first\nsecond'],['argument C1','node arg'+String.fromCharCode(133)],['only spaces','   ']])test(`strict command override refuses ${name} before native starts`,()=>{
 const result=strict({HARNESS_MCP_COMMAND:value});assert.equal(result.run.status,78,result.run.stderr);assert.match(result.run.stderr,/HARNESS_MCP_COMMAND/);assert.deepEqual(result.started,{});
});
test('a normal strict override reaches the actual parsed MCP config with unchanged word boundaries',()=>{
 const result=strict({HARNESS_MCP_COMMAND:"custom-node --flag=one two'words"});assert.equal(result.run.status,0,result.run.stderr);
 const config=JSON.parse(result.sessionFiles['test-agent/captured-mcp.json']);
 assert.equal(config.mcpServers['aify-comms'].command,'custom-node');assert.deepEqual(config.mcpServers['aify-comms'].args,['--flag=one',"two'words"]);
 assert.equal(config.mcpServers['aify-comms'].env.AIFY_SERVER_URL,'http://127.0.0.2:1');
});
test('JSON-safe runtime dollar, brace and backtick bytes remain literal data',()=>{
 const value='http://127.0.0.2:1/$ref/{key}/`literal`';const result=strict({HARNESS_ENDPOINT:value});assert.equal(result.run.status,0,result.run.stderr);
 const config=JSON.parse(result.sessionFiles['test-agent/captured-mcp.json']);assert.equal(config.mcpServers['aify-comms'].env.AIFY_SERVER_URL,value);
});
test('an unused default-mode command override keeps its warning-only behavior',()=>{
 const result=launch('claude',[],{cwd:'work',env:{HARNESS_MCP_COMMAND:'unused bad"argument'},bridgeFiles:{'claude-channel.js':'// owned presence only\n'}});
 assert.equal(result.run.status,0,result.run.stderr);assert.ok(Object.keys(result.started).length,'useful native stub not reached');assert.match(result.run.stderr,/HARNESS_MCP_COMMAND/);assert.match(result.run.stderr,/unused|ignored|not (used|applied)/i);
});
test('the built-in bridge under Program Files remains a single JSON argument',()=>{
 const result=strict({},text=>{const match=/^AIFY_BRIDGE_DIR_FWD="([^"]+)"/m.exec(text);assert.ok(match);return text.split(match[1]).join(match[1]+'/Program Files');});
 // Supply the presence file through the bridge world; missing backend processes are never run by the native stub.
 assert.equal(result.run.status,0,result.run.stderr);
 const config=JSON.parse(result.sessionFiles['test-agent/captured-mcp.json']);
 assert.equal(config.mcpServers['aify-comms'].command,'node');assert.equal(config.mcpServers['aify-comms'].args.length,1);
 assert.match(config.mcpServers['aify-comms'].args[0],/Program Files\/server\.js$/);
});
