// Descriptor-only loopback transport; no service endpoint, credential or retry queue is involved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { idProblems } from "./agent-definition-schema.mjs";

export const MODEL_POST_TIMEOUT_MS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The agreed body, both sources; anything else (a diagnostic firedAtUs included) is not part of the contract and never leaves.
const AGREED_FIELDS = ["instance", "lifetime", "harness", "source", "session", "transcriptIdentity", "endOffset", "recordUuid", "value"].sort().join();

/** PURE. Admission and native ordering are env's job; malformed local envelopes never leave this process. */
export function modelEnvelopeValid(body) {
  if (!body || Object.keys(body).sort().join() !== AGREED_FIELDS || body.harness !== "claude" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.instance || "") || !UUID.test(body.lifetime || "")
    || !(body.value === null || (typeof body.value === "string" && !/[\u0000-\u001f\u007f-\u009f]/.test(body.value)))) return false;
  if (body.source === "launch") return body.session === "" && body.transcriptIdentity === null && body.endOffset === null && body.recordUuid === null;
  return body.source === "model-command" && UUID.test(body.session || "") && UUID.test(body.recordUuid || "")
    && /^[0-9a-f]{64}$/.test(body.transcriptIdentity || "") && Number.isSafeInteger(body.endOffset) && body.endOffset > 0;
}

export async function postModelSelection(agentId, body, { env = process.env, home = os.homedir(), fetchImpl = fetch, read = (file) => fs.readFileSync(file, "utf8") } = {}) {
  if (idProblems(agentId).length || !modelEnvelopeValid(body) || body.instance !== env.AIFY_ENV_INSTANCE || body.lifetime !== env.AIFY_LIFETIME) return false;
  try {
    const root = process.platform === "win32" ? env.USERPROFILE || home : env.HOME || home;
    const descriptor = JSON.parse(read(path.join(root, ".aify", "env", `${body.instance}.json`)));
    if (!descriptor || Array.isArray(descriptor) || descriptor.instance !== body.instance || !Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0
      || typeof descriptor.startedAt !== "string" || Number.isNaN(Date.parse(descriptor.startedAt))
      || typeof descriptor.url !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(descriptor.url)) return false;
    const response = await fetchImpl(new URL(`/agents/${encodeURIComponent(agentId)}/model-selection`, descriptor.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(MODEL_POST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}
