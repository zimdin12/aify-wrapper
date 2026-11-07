// A real owned listener must survive readiness and die on cleanup; argv-only probes cannot prove either.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {CodexAuthProbe} from './codex-auth-probe.mjs';

for (const direct of [false, true]) {
  test(`${direct ? 'direct' : 'setsid'} repeated readiness preserves its listener, starts one Node waiter, and cleanup closes that same PID`, async () => {
    const result = new CodexAuthProbe({forceNoSetsid: direct}).run({environment: {AUTH_LISTEN_DELAY_MS: '600'}});
    assert.equal(result.run.status, 0, result.run.stderr);
    const listener = result.tui?.listener;
    assert.ok(listener);
    assert.equal(listener.live, true, 'readiness must not kill the app-server instead of the waiter');
    assert.equal(listener.reachable, true);
    assert.equal(listener.tokenSha256, result.server.token.sha256);
    assert.notEqual(listener.pid, process.pid);
    assert.equal(process.kill(process.pid, 0), true, 'positive control: the observer must see itself');
    const alive = () => {
      try { process.kill(listener.pid, 0); return true; }
      catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
    };
    const deadline = Date.now() + 3000;
    while (alive() && Date.now() < deadline) await delay(25);
    assert.equal(alive(), false, 'cleanup must close the same live listener before its30s orphan bound');
    assert.equal(result.wait?.childStarts, 0, 'the Node waiter must not start a process per attempt');
    assert.ok(result.wait.attempts >= 3, 'delayed real listener must exercise repeated attempts');
    assert.equal(Object.keys(result.sessionFiles).filter(key => /^codex-auth-probe\/wait-\d+\.json$/.test(key)).length, 1);
  });
}
