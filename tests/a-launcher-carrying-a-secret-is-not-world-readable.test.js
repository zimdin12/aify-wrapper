// A launcher that carries a credential must not be readable by everyone on the host.
//
// WRAP-M1, external review round 7. `keyEnv` values are baked into the launcher at render time and
// they have to be: an MCP server's `env` block REPLACES the inherited environment for that server, so
// omitting the key hands it nothing. The value therefore lands in a file, and `chmod +x` under the
// usual umask makes that file 0755 -- any account on the host can read a service credential out of a
// launcher in the operator's bin directory.
//
// LATENT TODAY, WHICH IS WHY IT IS WORTH FIXING NOW. No service sets `strictMcp: true` yet, so no
// launcher currently carries one. The moment one does, every render writes a world-readable
// credential and nothing says so. A guard added while the population is zero costs nothing to get
// right; added afterwards it is a rotation.
//
// TWO CHANGES, and the umask one is the subtler. `chmod` runs AFTER the bytes reach disk, so a
// tightened file is still world-readable for the window between the write and the chmod -- short,
// and on a shared host long enough to matter. Creating under `umask 077` closes that window, and the
// chmod then OPENS the ordinary case back up rather than being the only protection.
//
// WHAT WINDOWS CANNOT ANSWER, said out loud. MEASURED on this host: every rendered launcher reports
// mode 666 whatever chmod was asked for, because the filesystem carries no POSIX permission bits.
// So the mode assertions below are SKIPPED on win32 rather than deleted or asserted anyway -- an
// assertion that always fails would be silenced by someone, and one weakened until it passes proves
// nothing. On win32 what remains is the content detector and the shape of the branch, which catch the
// logic being removed; the bits themselves go unverified there, exactly as `bridge-running` goes
// unverified on Windows in aify-comms' doctor.
//
// THE CHECK IS ON CONTENT, NOT ON A FLAG. A caller that bakes the secret and a caller that sets the
// mode would be two places to keep in step, and the failure would be silent in exactly the direction
// that matters. It is also why the detector below was measured against a real render rather than
// written from the template: the placeholder is substituted INLINE, so the variable name is absent
// from the output and a name-based check reports every launcher as secret-free.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = path.join(ROOT, "render.sh");
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

/** Render one template, optionally with a strict-MCP fragment baked in. */
function render(fragmentB64) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-mode-"));
  const out = path.join(dir, "claude-aify");
  const r = spawnSync("bash", [RENDER, "claude-aify.sh.in", posix(out),
    "ENDPOINT=http://10.20.30.40:8800", "REGISTRY_FINGERPRINT=fp", "SERVICE_NAME=aify-comms",
    "WRAPPER_VERSION=0.6.0", "NATIVE_BASE=/tmp/base", "SCRIPT_DIR=/tmp/base",
    "MCP_TRANSPORT=stdio", "BRIDGE_DIR=/tmp/base/mcp/stdio", `STRICT_EXTRA_MCP_B64=${fragmentB64}`,
  ], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, `render failed: ${r.stdout}${r.stderr}`);
  return { dir, out };
}

/** The permission bits, as an octal string. */
const modeOf = (file) => (fs.statSync(file).mode & 0o777).toString(8);

/** Whether OTHER or GROUP can read it. The question the finding is actually about. */
const readableByOthers = (file) => Boolean(fs.statSync(file).mode & 0o044);

test("a launcher with a baked credential is private", () => {
  // The fragment is a real base64 payload: this is what a service with `strictMcp: true` produces,
  // and the credential would be inside it.
  const secret = Buffer.from('"x": {"command":"node","env":{"API_KEY":"sk-not-a-real-key"}}').toString("base64");
  const { dir, out } = render(secret);
  try {
    assert.ok(
      fs.readFileSync(out, "utf8").includes(secret),
      "the fragment did not reach the launcher, so this test is not looking at a secret-carrying file",
    );
    if (process.platform === "win32") {
      // NOT A PASS. This host reports 666 for every file; see the header.
      assert.match(
        fs.readFileSync(RENDER, "utf8"), /chmod 700/,
        "render.sh no longer tightens a secret-carrying launcher, and this platform cannot check modes",
      );
    } else {
      assert.equal(
        readableByOthers(out), false,
        `a launcher carrying a credential is mode ${modeOf(out)} -- readable by other accounts here`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("and an ordinary launcher is still executable by everyone", () => {
  // CONTRADICTION ARM. Tightening every render would pass the test above and break a genuinely shared
  // install for a risk those files do not carry. The mode must depend on the content.
  const { dir, out } = render("");
  try {
    assert.match(
      fs.readFileSync(out, "utf8"), /printf '%s' "" \| base64 -d/,
      "this render was expected to carry no fragment; the detector's premise has changed",
    );
    // THE WHOLE MODE, NOT ONE BIT. External review, Round 8 M2: `render.sh` used `chmod +x`, which
    // only ADDS the execute bit to the 0600 the writer created -- giving 0711, not the 0755 its own
    // comment promises. This assertion read `mode & 0o100`, the OWNER's execute bit, and passed on
    // 0711 for eleven days. 0711 is worse than it looks for a SHELL script: another user may execute
    // it and not READ it, and an interpreter must read a script to run it.
    if (process.platform === "win32") {
      // THIS HOST CANNOT OBSERVE MODES -- measured: chmod 600, chmod +x and chmod 755 all report
      // 644, and node reads 666 for every file. So the bits are unavailable here and the SOURCE is
      // what can be checked. Named rather than skipped: a test that cannot fail must say why.
      assert.match(
        fs.readFileSync(RENDER, "utf8"), /chmod 755 "\$target"/,
        "render.sh no longer sets an ordinary launcher to 755. `chmod +x` is not equivalent: it adds "
        + "a bit to the 0600 create mode and yields 0711, which other users can execute but not read",
      );
    } else {
      assert.equal(
        modeOf(out), "755",
        `an ordinary launcher is mode ${modeOf(out)}. It must be 755: 711 lets another user execute `
        + "a shell script they cannot read, which no interpreter can actually do",
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the two renders really do differ, so the comparison means something", () => {
  // POSITIVE CONTROL on the detector. Both assertions above would hold if render.sh ignored the
  // fragment entirely and every file came out identical -- the secret-carrying case would simply
  // never occur. This proves the input reaches the output and changes it.
  const secret = Buffer.from("marker-for-the-control").toString("base64");
  const withSecret = render(secret);
  const without = render("");
  try {
    const a = fs.readFileSync(withSecret.out, "utf8");
    const b = fs.readFileSync(without.out, "utf8");
    assert.notEqual(a, b, "the fragment made no difference to the rendered launcher");
    assert.ok(a.includes(secret), "the fragment is absent from the render that was given one");
    assert.ok(!b.includes(secret), "the fragment appeared in a render that was not given one");
  } finally {
    fs.rmSync(withSecret.dir, { recursive: true, force: true });
    fs.rmSync(without.dir, { recursive: true, force: true });
  }
});
