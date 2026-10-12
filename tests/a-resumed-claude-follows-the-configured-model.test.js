#!/usr/bin/env node
// A resumed Claude session runs the model the configuration names now, not the one its transcript saved.
//
// Claude restores a resumed session's saved model unless the launch names one (Claude Code docs, model
// configuration). So claude-aify, resuming with no model chosen by a flag, a managed launch or a definition,
// passes the model Claude's settings give a new session. Executed through the REAL rendered launcher to a stub
// runtime that records its argv; the run's HOME and working directory are its own.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { claudeDefaultModel, claudeSettingsFiles, readSettings } from "../lib/claude-default-model.mjs";
import { KNOWN, launch } from "./launch-to-a-stub-runtime.mjs";

const settings = (model) => JSON.stringify({ model });
const modelsIn = (args) => args.flatMap((arg, i) => (arg === "--model" ? [args[i + 1]] : []));
const resume = (options) => launch("claude", ["--resume", KNOWN], { cwd: "work", ...options });

test("a resume with no model chosen passes the user settings' model", () => {
  const { run, args } = resume({ files: { "<home>/.claude/settings.json": settings("opus") } });
  assert.deepEqual(modelsIn(args), ["opus"], `${args.join(" ")}\n${run.stderr}`);
});

test("and with MSYS path rewriting off, where node is handed the directory as the launcher writes it", () => {
  const { run, args } = resume({ rewriting: false, files: { "work/.claude/settings.json": settings("sonnet") } });
  assert.deepEqual(modelsIn(args), ["sonnet"], `${args.join(" ")}\n${run.stderr}`);
});

test("CONTROL: with no settings naming a model, the resume passes none, as before", () => {
  const { run, args } = resume({ files: { "<home>/.claude/settings.json": JSON.stringify({ effortLevel: "high" }) } });
  assert.ok(args.length, `the runtime never started:\n${run.stderr}`);
  assert.deepEqual(modelsIn(args), []);
});

test("the project's local settings win over its shared settings, and both over the user's", () => {
  const files = { "<home>/.claude/settings.json": settings("opus"), "work/.claude/settings.json": settings("sonnet") };
  assert.deepEqual(modelsIn(resume({ files }).args), ["sonnet"]);
  assert.deepEqual(modelsIn(resume({ files: { ...files, "work/.claude/settings.local.json": settings("haiku") } }).args),
    ["haiku"]);
});

test("a model chosen another way wins, and is passed once", () => {
  const files = { "<home>/.claude/settings.json": settings("opus") };
  const flagged = launch("claude", ["--resume", KNOWN, "--model", "claude-opus-5"], { cwd: "work", files });
  assert.deepEqual(modelsIn(flagged.args), ["claude-opus-5"], "the user's own --model");
  assert.deepEqual(modelsIn(resume({ files, env: { AIFY_AGENT_ID: "x", AIFY_MANAGED_MODEL: "sonnet" } }).args), ["sonnet"],
    "a managed launch's model");
  assert.deepEqual(modelsIn(resume({ files, env: { ANTHROPIC_MODEL: "sonnet" } }).args), [],
    "ANTHROPIC_MODEL, which Claude itself honours first");
});

test("a NEW session passes nothing: Claude reads its settings itself", () => {
  const { run, args } = launch("claude", [], { cwd: "work", files: { "<home>/.claude/settings.json": settings("opus") } });
  assert.ok(args.length, `the runtime never started:\n${run.stderr}`);
  assert.deepEqual(modelsIn(args), []);
});

test("claudeDefaultModel: the first usable model, most specific first", () => {
  assert.equal(claudeDefaultModel([null, { model: "sonnet" }, { model: "opus" }]), "sonnet");
  assert.equal(claudeDefaultModel([{ model: "" }, { model: "  " }, { model: 5 }, { model: "opus" }]), "opus");
  assert.equal(claudeDefaultModel([{ model: "bad\nmodel" }, { model: "opus" }]), "opus", "a control character is skipped");
  assert.equal(claudeDefaultModel([null, "x", [], {}]), "");
});

test("readSettings: a missing or unparseable file names no model, and the next one still answers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-"));
  try {
    const broken = path.join(dir, "broken.json");
    const good = path.join(dir, "good.json");
    fs.writeFileSync(broken, "{ not json");
    fs.writeFileSync(good, settings("opus"));
    const read = readSettings([path.join(dir, "missing.json"), broken, good]);
    assert.deepEqual(read, [null, null, { model: "opus" }]);
    assert.equal(claudeDefaultModel(read), "opus");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("claudeSettingsFiles: local, project, then the user's, which CLAUDE_CONFIG_DIR moves", () => {
  const cwd = path.join("w");
  assert.deepEqual(claudeSettingsFiles(cwd, { HOME: "h" }), [path.join("w", ".claude", "settings.local.json"),
    path.join("w", ".claude", "settings.json"), path.join("h", ".claude", "settings.json")]);
  assert.equal(claudeSettingsFiles(cwd, { HOME: "h", CLAUDE_CONFIG_DIR: "c" })[2], path.join("c", "settings.json"));
});
