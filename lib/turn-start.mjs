// The turn-start runner's core: what an agent is told as its turn begins, asked of every registry service that declares
// `turnStart` (aify-dashboard DESIGN-INTEGRATION item 4). bin/aify-turn-start.mjs is the hook command around it.
//
// THE TURN NEVER WAITS ON THIS. One shared deadline bounds every request and every response body; a service's own
// `budgetMs` only shortens its own wait. A service that is slow, fails, answers in a shape it should not, or has no
// key contributes nothing, and the others' answers still arrive. Nothing here throws to its caller.
//
// THE KEY STAYS IN ITS HEADER. A redirect is refused rather than followed with the key, and an outcome names a reason,
// never an error message that could carry a request detail.

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

/** One service's answer: its text, or "" with the reason it contributes nothing. */
async function askOne(target, { request, keyFor, fetchImpl, allowanceMs }) {
  const key = keyFor(target.credentialRef);
  if (!key) return { service: target.service, text: "", reason: "no-key" };
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
 * Ask every target at once and join what came back, in target order.
 * @param {{targets: object[], request: {agentId: string, cwd: string, machineId: string, sessionKey: string},
 *   keyFor: (ref: string) => string, fetchImpl: Function, remainingMs: number}} input
 * @returns {Promise<{text: string, outcomes: object[]}>}
 */
export async function runTurnStart({ targets, request, keyFor, fetchImpl, remainingMs }) {
  const outcomes = await Promise.all(targets.map((target) =>
    askOne(target, { request, keyFor, fetchImpl, allowanceMs: Math.min(target.budgetMs, remainingMs) })));
  const text = outcomes.map((outcome) => outcome.text).filter((piece) => piece !== "").join("\n\n");
  return { text, outcomes };
}

/** PURE. Claude's UserPromptSubmit output for `text`, or "" when there is nothing to add. */
export function hookOutput(text) {
  if (!text) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });
}
