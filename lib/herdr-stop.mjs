// Stopping what herdr-aify started: `herdr-aify --stop` for this host's resident herdr, `herdr-aify env --stop` for
// the env instance. Its own module because both outlive every launcher since 0.8.6, so a stop is the only way either
// ends on purpose, and it has to be addressable without the launcher that started it.

import { herdr, serverAnswer } from "./herdr-cli.mjs";
import { resolveHerdrBinary } from "./herdr-binary.mjs";
import { herdrServerEnv, profilePaths, residentPaths } from "./herdr-profile.mjs";
import { serverEnvFor } from "./herdr-resident.mjs";
import { clearProfileOwner, profileOwnerState } from "./herdr-owner.mjs";

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Which instance a stop is for: `herdr-aify env --stop` ends the env instance, a bare `--stop` only this host's
 * resident herdr. A bare stop used to end the env instance whenever one was recorded, taking aify-env and every
 * managed worker with it when the operator meant the resident (2026-10-05).
 */
export function stopTarget(argv = []) {
  return argv.includes("env") ? "env" : "resident";
}

/**
 * Ask until herdr says nothing runs there, for up to five seconds. A stop that was ACCEPTED has a server still
 * exiting: asked once, straight after, it answered neither "serving" nor "not running", and a sealed real run
 * reported "could not confirm it is gone" for a server that was gone a moment later (2026-10-05).
 */
async function goneWithin(ask, sleep, { tries = 20, everyMs = 250 } = {}) {
  let answer = ask();
  for (let i = 1; i < tries && answer !== "not-running"; i += 1) {
    await sleep(everyMs);
    answer = ask();
  }
  return answer;
}

/** What a post-stop read says, in words. Three answers, because "could not tell" is not "still up". */
function goneWords(answer) {
  if (answer === "not-running") return "confirmed gone";
  if (answer === "serving") return "STILL ANSWERING";
  return "could not confirm it is gone";
}

/**
 * End the instance a stop names, whether or not its launcher is still around.
 *
 * WHY THIS EXISTS. Teardown normally runs from the launcher's signal handlers, and on Windows those
 * only fire for a real console Ctrl-C or a window close. `taskkill`, End Task, a dying parent, or an
 * SSH session going away deliver nothing — measured: a launcher killed that way left its dedicated
 * Herdr, its aify-env and their panes running, with an owner pointer nobody would ever clear. Since
 * 0.8.6 leaving detaches too, so this is the ONLY way an env instance ends on purpose.
 *
 * The instance is still perfectly addressable in that state: the owner pointer names the invocation,
 * and the invocation names a socket. So this is not a workaround, it is the direct route.
 */
export async function stopRecorded({ profileRoot, env = process.env, target = "resident", cli = herdr, sleep = sleepFor } = {}) {
  const state = await profileOwnerState(profileRoot);
  if (target === "env" && !state?.invocation) {
    process.stderr.write("herdr-aify: no herdr-aify env instance is recorded; nothing stopped\n");
    return 0;
  }
  const bin = resolveHerdrBinary({ env }).bin;
  if (target === "resident") {
    if (state?.invocation) {
      process.stderr.write(`herdr-aify: the herdr-aify env instance ${state.invocation} keeps running; \`herdr-aify env --stop\` ends it\n`);
    }
    // THE RESIDENT IS THE OTHER THING THIS COMMAND CAN HOLD, and it outlives every launcher — so
    // "nothing recorded" is not the same as "nothing running". Detaching from it is the ordinary
    // way to leave; this is how an operator ends it on purpose.
    const resident = serverEnvFor(env, residentPaths({ profileRoot }));
    const before = cli(["pane", "list"], { bin, env: resident });
    const running = serverAnswer(before);
    if (running === "serving") {
      const stopped = cli(["server", "stop"], { bin, env: resident });
      const after = await goneWithin(() => serverAnswer(cli(["pane", "list"], { bin, env: resident })), sleep);
      process.stderr.write(
        `herdr-aify: this host's herdr — ${stopped.ok ? "stop accepted" : `stop refused (${stopped.error})`}, ` +
          `${goneWords(after)}\n`,
      );
      return after === "not-running" ? 0 : 1;
    }
    // "COULD NOT ASK" WAS REPORTED AS "NOTHING IS RUNNING", which is false in exactly the case where
    // the operator most needs the truth: a resident that is up but slow to answer.
    if (running === "unknown") {
      process.stderr.write(`herdr-aify: could not tell whether this host's herdr is running (${before.error}); nothing was stopped\n`);
      return 1;
    }
    process.stderr.write("herdr-aify: this host's herdr is not running; nothing stopped\n");
    return 0;
  }
  const serverEnv = herdrServerEnv(env, profilePaths({ profileRoot, invocation: state.invocation }));
  const stopped = cli(["server", "stop"], { bin, env: serverEnv });
  // ASKED AGAIN, because "the request was accepted" is not "the server is gone", and this command's
  // entire job is the second one.
  const after = await goneWithin(() => serverAnswer(cli(["pane", "list"], { bin, env: serverEnv })), sleep);
  // THE POINTER GOES ONLY WITH THE INSTANCE. It is the one handle on a detached instance: cleared after a stop that
  // failed, the next `herdr-aify env` read "nothing recorded", started a second aify-env beside the first, and
  // nothing could name the first one again (review of 0.8.6).
  if (after === "not-running") clearProfileOwner(profileRoot, state.invocation);
  process.stderr.write(
    `herdr-aify: invocation ${state.invocation} — ` +
      `${stopped.ok ? "stop accepted" : `stop refused (${stopped.error})`}, ` +
      `${goneWords(after)}${after === "not-running" ? "" : "; still recorded, so `herdr-aify env --stop` can try again"}\n`,
  );
  return after === "not-running" ? 0 : 1;
}
