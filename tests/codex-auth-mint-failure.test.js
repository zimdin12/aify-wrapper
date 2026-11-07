// The pure calculation tests do not cover the launcher's one-shot status/frame boundary.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {CodexAuthProbe} from './codex-auth-probe.mjs';

// Old Bash spills here-strings/documents to disk; runtime tests on newer Bash cannot observe that path.
test('private material parser uses no here-string or here-document', () => {
  const source = fs.readFileSync(new URL('../wrappers/codex-aify.sh.in', import.meta.url), 'utf8');
  const from = source.indexOf('_aify_auth_material="$(node'), to = source.indexOf('CODEX_APP_SERVER_AUTH=', from);
  assert.ok(from >= 0 && to > from, 'the actual material parser must be found');
  const parser = source.slice(from, to);
  assert.match(parser, /AIFY_CODEX_APP_SERVER_TOKEN_SHA256/);
  assert.match(parser, /export AIFY_CODEX_APP_SERVER_TOKEN/);
  assert.doesNotMatch(parser, /<</, 'raw material must not enter shell here-strings/documents on any Bash version');
});

const valid = {token: 'A'.repeat(43), sha256: '0'.repeat(64)};
const cases = [
  ['throw', 'throw new Error("owned mint failure");'],
  ['invalid token', `return ${JSON.stringify({...valid, token: 'short'})};`],
  ['invalid verifier', `return ${JSON.stringify({...valid, sha256: 'not-a-digest'})};`],
  ['extra field', `return ${JSON.stringify({...valid, sha256: valid.sha256 + '\tunexpected'})};`],
];
for (const [name, body] of cases) {
  test(`mint pipeline ${name} refuses78 before runtime effects; check does not import it`, () => {
    const helper = `import fs from 'node:fs';import path from 'node:path';
      const dir=path.join(process.env.HOME,'.aify/sessions/mint-pipeline');
      fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'imported'),'owned fixture import');
      export function codexAuthMaterial(){${body}}`;
    const files = {'wrapper/lib/codex-app-server-auth.mjs': helper};
    const result = new CodexAuthProbe().run({files});
    assert.deepEqual({status: result.run.status, named: result.run.stderr.includes('could not create app-server authentication'),
      imported: result.sessionFiles['mint-pipeline/imported'], server: result.server, tui: result.tui, args: result.appServerArgs},
    {status: 78, named: true, imported: 'owned fixture import', server: null, tui: null, args: []});
    const check = new CodexAuthProbe().run({args: ['--check'], files});
    assert.equal(check.run.status, 0, check.run.stderr);
    assert.match(check.run.stdout, /capability-token required/);
    assert.equal(check.sessionFiles['mint-pipeline/imported'], undefined);
    assert.equal(check.server, null);
    assert.equal(check.tui, null);
  });
}
