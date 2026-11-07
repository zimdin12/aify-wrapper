// Real wrapper producer env -> maintained comms registration reader, inside the owned app-server child.
// This does not qualify comms' activation-time secret-variable allowlist or native resident dispatch.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {CodexAuthProbe} from './codex-auth-probe.mjs';
import {checkoutSource} from './sibling-checkouts.mjs';

test('comms registration consumes the actual wrapper pointer name without copying its capability', () => {
  const {root} = checkoutSource({variable: 'AIFY_COMMS_REPO', files: ['mcp/stdio/registration-inputs.mjs'], env: process.env, required: true});
  const result = new CodexAuthProbe().run({environment: {
    AUTH_REGISTRATION_MODULE: pathToFileURL(path.join(root, 'mcp/stdio/registration-inputs.mjs')).href,
  }});
  assert.equal(result.run.status, 0, result.run.stderr);
  assert.equal(result.server.token.valid, true);
  assert.equal(result.server.registration.containsRawToken, false);
  const appServerUrl = result.appServerEnv.AIFY_CODEX_APP_SERVER_URL;
  assert.match(appServerUrl, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(result.server.registration.current, {appServerUrl, remoteAuthTokenEnv: 'AIFY_CODEX_APP_SERVER_TOKEN'});
  assert.deepEqual(result.server.registration.unnamed, {appServerUrl}, 'negative control: no pointer means no invented auth config');
});
