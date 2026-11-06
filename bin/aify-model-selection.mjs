#!/usr/bin/env node
// init <claimed-agent> <resolved-resume-id> <own-hook-settings> -- <original-launch-argv...>
// hook < native hook JSON, or finish with no stdin. Reporting errors are best-effort; the launcher owns runtime status.
import { isMainModule } from "../lib/main-module.mjs";
import { ModelSelectionReporter } from "../lib/model-selection-reporter.mjs";

function hookInput(stream) {
  return new Promise((resolve) => {
    let bytes = 0; const chunks = [];
    const done = (value) => {
      clearTimeout(timer); stream.removeListener("data", data); stream.removeListener("end", end); stream.removeListener("error", error);
      stream.pause(); resolve(value);
    };
    const data = (chunk) => { bytes += chunk.length; if (bytes > 64 * 1024) done(null); else chunks.push(chunk); };
    const end = () => { try { done(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); } catch { done(null); } };
    const error = () => done(null);
    const timer = setTimeout(() => done(null), 1000);
    stream.on("data", data); stream.once("end", end); stream.once("error", error);
  });
}

export async function modelSelectionMain(argv = process.argv.slice(2), env = process.env) {
  const [mode, claimedAgent, resumeId, ownSettings, separator, ...original] = argv;
  if (mode !== "init" && (!env.AIFY_LIFETIME || env.AIFY_MODEL_SELECTION !== env.AIFY_LIFETIME)) return;
  const reporter = new ModelSelectionReporter({ env });
  if (mode === "init") {
    if (separator !== "--") return;
    const result = await reporter.initialize({ claimedAgent, resumeId, ownSettings, argv: original });
    if (result.ready) process.stdout.write(env.AIFY_LIFETIME);
    else if (claimedAgent) process.stderr.write(`[claude-aify] model selection reporting unavailable: ${result.problem}\n`);
  } else if (mode === "hook") {
    const payload = await hookInput(process.stdin);
    if (payload) await reporter.hook(payload);
  } else if (mode === "finish") await reporter.finish();
}

if (isMainModule(import.meta.url)) {
  const deadline = setTimeout(() => { process.stderr.write("[claude-aify] model selection helper deadline; not queued\n"); process.exit(0); }, 4000);
  deadline.unref();
  modelSelectionMain().catch(() => process.stderr.write("[claude-aify] model selection helper failed; not queued\n"))
    .finally(() => clearTimeout(deadline));
}
