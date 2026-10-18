// The turn-start runner's core: what an agent is told as its turn begins, asked of every registry service that declares
// `turnStart` (aify-dashboard DESIGN-INTEGRATION item 4). bin/aify-turn-start.mjs is the hook command around it.
//
// THE TURN NEVER WAITS ON THIS. One ABSOLUTE due time bounds everything: a service's allowance is computed against it
// right before its request (after its key is read), its own `budgetMs` only brings its own due time earlier, and the
// answer closes at the due time with whatever has already arrived, so a peer still pending never drops a fast one's
// text. A service that is slow, fails, answers in a shape it should not, or has no key contributes nothing.
//
// NO KEY LEAVES. A redirect is refused rather than followed with the key; an outcome names a reason, never an error
// message; and a text that contains any key this invocation presented is refused, since it would otherwise be printed
// into the agent's context.

/** The services that declare turnStart, in the parsed registry's own order, each with the URL it is called on. */
export function turnStartTargets(registry) {
  const services = registry?.services ?? {};
  return Object.keys(services)
    .filter((name) => services[name].turnStart)
    .map((name) => ({
      service: name,
      url: services[name].endpoint.replace(/\/+$/, "") + services[name].turnStart.path,
      budgetMs: services[name].turnStart.budgetMs,
      credentialRef: services[name].credentialRef,
    }));
}

/** One service's answer: its text, or "" with the reason it contributes nothing. `presented` collects its key. */
async function askOne(target, { request, keyFor, fetchImpl, startedAt, dueAt, now, presented }) {
  const key = await keyFor(target.credentialRef);
  if (!key) return { service: target.service, text: "", reason: "no-key" };
  presented.add(key);
  // Computed now, after the key was read: preparation spends the same deadline the request does.
  const allowanceMs = Math.min(dueAt, startedAt + target.budgetMs) - now();
  if (allowanceMs <= 0) return { service: target.service, text: "", reason: "timeout" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), allowanceMs);
  try {
    const response = await fetchImpl(target.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "x-aify-agent": request.agentId },
      body: JSON.stringify(request),
      redirect: "error",
      signal: controller.signal,
    });
    // The body is read under the same signal, so a service that sends headers and then stalls is still cut.
    const raw = await response.text();
    if (response.status !== 200) return { service: target.service, text: "", reason: `status-${response.status}` };
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return { service: target.service, text: "", reason: "not-json" };
    }
    if (typeof body?.text !== "string") return { service: target.service, text: "", reason: "no-text" };
    return { service: target.service, text: body.text, reason: "" };
  } catch {
    return { service: target.service, text: "", reason: controller.signal.aborted ? "timeout" : "error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask every target at once and join what came back by `dueAt`, in target order.
 * @param {{targets: object[], request: {agentId: string, cwd: string, machineId: string, sessionKey: string},
 *   keyFor: (ref: string) => (string|Promise<string>), fetchImpl: Function, startedAt: number, dueAt: number,
 *   now?: () => number}} input
 * @returns {Promise<{text: string, outcomes: object[]}>}
 */
export async function runTurnStart({ targets, request, keyFor, fetchImpl, startedAt, dueAt, now = Date.now }) {
  const presented = new Set();
  const outcomes = targets.map((target) => ({ service: target.service, text: "", reason: "timeout" }));
  const settled = Promise.all(targets.map((target, index) =>
    askOne(target, { request, keyFor, fetchImpl, startedAt, dueAt, now, presented })
      .catch(() => ({ service: target.service, text: "", reason: "error" }))
      .then((outcome) => { outcomes[index] = outcome; })));
  // THE FENCE: the answer is what had arrived by the due time. A peer still pending keeps its "timeout".
  let fence;
  await Promise.race([settled, new Promise((resolve) => { fence = setTimeout(resolve, Math.max(0, dueAt - now())); })]);
  clearTimeout(fence);
  const closed = outcomes.map((outcome) => {
    if (outcome.text && [...presented].some((key) => outcome.text.includes(key))) {
      return { service: outcome.service, text: "", reason: "reflects-key" };
    }
    return { ...outcome };
  });
  const text = closed.map((outcome) => outcome.text).filter((piece) => piece !== "").join("\n\n");
  return { text, outcomes: closed };
}

/** PURE. Claude's UserPromptSubmit output for `text`, or "" when there is nothing to add. */
export function hookOutput(text) {
  if (!text) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });
}
