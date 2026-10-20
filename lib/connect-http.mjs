// The requests connect makes: none follows a redirect, none forwards a key anywhere it was not sent, all are bounded.
//
// A REDIRECT IS AN ABORT, at every stage. On the spec fetch it is refused before any key is read. During the keyed
// probe it may appear only when the right key is sent, which is exactly the case where following it would hand
// that key to whatever `Location` names; so it is never followed and the connect stops with nothing published.

import { createHash, randomBytes } from "node:crypto";

import { SPEC_PATH, resolveRoute } from "./service-spec.mjs";

export const REQUEST_TIMEOUT_MS = 10_000;

export class RedirectRefused extends Error {}

async function request(url, { headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  if (response.status >= 300 && response.status < 400) {
    // The body is dropped unread and Location is named, never requested.
    throw new RedirectRefused(`${url} answered ${response.status} towards ${response.headers.get("location") ?? "(no location)"}; redirects are never followed`);
  }
  return response;
}

export class NoSpec extends Error {}

/**
 * The service's spec, fetched with no key. Anything but a 200 `application/json` body holding `specVersion: 1` is
 * "this service serves no spec", a clean refusal and never a malformed spec: a dashboard before 1.3.10 answers an
 * unknown /.well-known/ path with its web page (200 text/html), and a comms without the route answers 401 JSON.
 */
export async function fetchSpec(endpoint) {
  const url = resolveRoute(endpoint, SPEC_PATH);
  const response = await request(url);
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const none = (why) => new NoSpec(`${url} serves no spec (${why}); nothing was read or written`);
  if (response.status !== 200) {
    await response.arrayBuffer();
    throw none(`it answered ${response.status}`);
  }
  if (type !== "application/json") {
    await response.arrayBuffer();
    throw none(`it answered ${type || "no content type"}, not application/json`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw none("its body is not JSON");
  }
  if (body?.specVersion !== 1) throw none(`specVersion is ${JSON.stringify(body?.specVersion)}, not 1`);
  return body;
}

/** `verify.health`: 200 with no key. */
export async function checkHealth(endpoint, spec) {
  const url = resolveRoute(endpoint, spec.verify.health.path);
  const response = await request(url);
  await response.arrayBuffer();
  if (response.status !== 200) throw new Error(`${url} answered ${response.status}, not 200`);
}

/**
 * One probe, in the order that sends the real key last: no key must be refused (401), a wrong key must be refused
 * (401), and only then is the key itself sent (200). A service that answers 200 without a key never sees it.
 */
export async function checkProbe(endpoint, probe, key) {
  const url = resolveRoute(endpoint, probe.path);
  let wrong = randomBytes(24).toString("hex");
  if (wrong === key) wrong = `${wrong}0`;
  for (const [label, headers, expected] of [
    ["no key", {}, 401],
    ["a wrong key", { [probe.header]: wrong }, 401],
    ["the key", { [probe.header]: key }, 200],
  ]) {
    const response = await request(url, { headers });
    await response.arrayBuffer();
    if (response.status !== expected) throw new Error(`${url} answered ${response.status} to ${label}, not ${expected}`);
  }
}

/** A served artifact's bytes, fetched with the service key and checked against the spec's sha256 before use. */
export async function fetchServed(endpoint, artifact, header, key) {
  const url = resolveRoute(endpoint, artifact.source.served.path);
  const response = await request(url, { headers: { [header]: key }, timeoutMs: 60_000 });
  if (response.status !== 200) throw new Error(`${url} answered ${response.status}, not 200`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) throw new Error(`${artifact.id}: served bytes hash ${digest}, not the spec's ${artifact.sha256}`);
  return bytes;
}
