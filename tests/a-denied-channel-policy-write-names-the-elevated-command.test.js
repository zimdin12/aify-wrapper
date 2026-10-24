import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INSTALL = fileURLToPath(new URL('../lib/channel-install.mjs', import.meta.url));
const PRELOAD = new URL('./data/channel-policy-denied-preload.mjs', import.meta.url).href;

test('a denied Windows policy write exits 78 with a copyable elevated command', {
  skip: process.platform !== 'win32' && 'the native Windows CLI and PowerShell parser are required',
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-denied-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = path.join(root, "bridge O'Brien & data"), home = path.join(root, 'home');
  fs.mkdirSync(bridge); fs.mkdirSync(home);
  fs.writeFileSync(path.join(bridge, 'claude-channel-plugin.mjs'), '// fixture entry is never executed\n');
  fs.writeFileSync(path.join(bridge, 'claude-channel.js'), 'export const CHANNEL_PRODUCER_GATE = 1;\n');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'aify-comms-channel': { command: 'node', args: [path.join(bridge, 'claude-channel.js')] } },
  }));
  const calls = path.join(root, 'calls.jsonl');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'ProgramFiles', 'NODE_OPTIONS'].some(name => name.toUpperCase() === key.toUpperCase())));
  Object.assign(env, { HOME: home, USERPROFILE: home, ProgramFiles: path.join(root, 'program-files'), CHANNEL_POLICY_CALLS: calls });
  const run = command => spawnSync(process.execPath,
    ['--import', PRELOAD, INSTALL, command, '--bridge-dir', path.relative(root, bridge)],
    { cwd: root, env, encoding: 'utf8', windowsHide: true });
  const readCalls = () => fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);

  // Positive control: the same real CLI enters its read-only command with a valid development route.
  const check = run('check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /route: dev/);
  assert.ok(readCalls().some(call => call.kind === 'read' && call.key.includes('HKCU')));
  assert.ok(!readCalls().some(call => call.kind === 'write'));

  const denied = run('install');
  assert.equal(denied.status, 78, denied.stderr);
  assert.match(denied.stderr, /Access to the registry key is denied/);
  assert.equal(readCalls().filter(call => call.kind === 'write').length, 1, 'the fixture reached the actual write adapter');
  assert.equal(fs.existsSync(path.join(home, '.aify')), false, 'no plugin files were rendered after the refused write');
  assert.match(denied.stderr, /PowerShell as Administrator/);
  assert.match(denied.stderr, /same Windows (?:user|account)/);
  const command = denied.stderr.split(/\r?\n/).find(line => line.startsWith('& '));
  assert.ok(command, 'the refusal must include a standalone PowerShell command');

  // Parse, never execute, the suggested command. An apostrophe is invalid in an unescaped quoted argument.
  const parser = String.raw`
    $goodErrors = $null; $badErrors = $null; $tokens = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($env:CHANNEL_REPAIR, [ref]$tokens, [ref]$goodErrors)
    [void][System.Management.Automation.Language.Parser]::ParseInput("'", [ref]$tokens, [ref]$badErrors)
    @{ errors = @($goodErrors).Count; invalidControlErrors = @($badErrors).Count;
       argv = @($ast.EndBlock.Statements[0].PipelineElements[0].CommandElements | ForEach-Object { $_.Value }) } | ConvertTo-Json -Compress
  `;
  const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parser],
    { env: { ...env, CHANNEL_REPAIR: command }, encoding: 'utf8', windowsHide: true });
  assert.equal(parsed.status, 0, parsed.stderr);
  const syntax = JSON.parse(parsed.stdout);
  assert.ok(syntax.invalidControlErrors > 0, 'the same parser must reject known invalid syntax');
  assert.equal(syntax.errors, 0, command);
  assert.deepEqual(syntax.argv, [process.execPath, INSTALL, 'install', '--bridge-dir', bridge]);
});
