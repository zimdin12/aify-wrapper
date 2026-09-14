#!/usr/bin/env node
// Finding the `herdr` binary, which the first real `herdr-aify` run could not do.
//
// THE DEFECT, reported by the operator on their own machine: `herdr-aify` died with
// `spawn herdr ENOENT` on a host where Herdr was installed and working. Measured afterwards, the
// Herdr install directory is on NEITHER the user nor the system PATH in the registry — Herdr puts
// itself on PATH for the shells IT starts, and for anything that inherited it. So the bare name
// resolved for the developer's shell and failed from the operator's prompt, which is the worst
// possible split.
//
// AND `ENOENT` TOLD THEM NOTHING. The whole diagnosis is the list of places that were tried, so a
// refusal that does not carry it is barely better than the crash.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { candidatePaths, resolveHerdrBinary } from "../lib/herdr-binary.mjs";

const HOME = path.join("C:", "Users", "Someone");
const STANDALONE = path.join(HOME, ".herdr", "packages", "standalone");
const LINUX_HOME = path.join("/home", "someone");

/** An `io` that says only the named paths exist. */
function diskWith(present = [], releases = []) {
  return {
    existsSync: target => present.includes(target),
    readdirSync: () => {
      if (!releases.length) throw new Error("ENOENT");
      return releases;
    },
  };
}

test("HERDR_BIN_PATH wins, because inside a pane it names the exact binary that opened it", () => {
  const exact = path.join("D:", "herdr", "herdr.exe");
  const resolved = resolveHerdrBinary({
    env: { HERDR_BIN_PATH: exact },
    home: HOME,
    platform: "win32",
    io: diskWith([exact]),
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.bin, exact);
});

test("an explicit HERDR_BIN_PATH is NOT second-guessed, even when the file check says no", () => {
  // Searching past it would mean silently talking to a DIFFERENT Herdr than the one that set it —
  // and inside a pane that variable is Herdr's own statement about which server owns this terminal.
  // A wrong value should fail loudly at spawn, not succeed against the wrong server.
  const named = path.join("D:", "gone", "herdr.exe");
  const onDisk = path.join(STANDALONE, "current", "herdr.exe");
  const resolved = resolveHerdrBinary({
    env: { HERDR_BIN_PATH: named },
    home: HOME,
    platform: "win32",
    io: diskWith([onDisk]),
  });
  assert.equal(resolved.bin, named, "an installed binary was preferred over the one Herdr named");
  // An empty value is the shape of an unset one and must not win.
  const blank = resolveHerdrBinary({ env: { HERDR_BIN_PATH: "" }, home: HOME, platform: "win32", io: diskWith([onDisk]) });
  assert.equal(blank.bin, onDisk);
});

test("the stable `current` link is used when nothing names a binary", () => {
  // Herdr's installer maintains packages/standalone/current beside the versioned releases, which is
  // how to name the current binary without pinning a version.
  const current = path.join(STANDALONE, "current", "herdr.exe");
  const resolved = resolveHerdrBinary({ env: {}, home: HOME, platform: "win32", io: diskWith([current]) });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.bin, current);
});

test("a release directory is used when `current` is missing or broken", () => {
  const release = path.join(STANDALONE, "releases", "0.9.0-x86_64-pc-windows-msvc", "herdr.exe");
  const resolved = resolveHerdrBinary({
    env: {},
    home: HOME,
    platform: "win32",
    io: diskWith([release], ["0.9.0-x86_64-pc-windows-msvc"]),
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.bin, release);
});

test("the newest release is preferred when there are several", () => {
  const older = path.join(STANDALONE, "releases", "0.8.0-x86_64", "herdr.exe");
  const newer = path.join(STANDALONE, "releases", "0.9.0-x86_64", "herdr.exe");
  const resolved = resolveHerdrBinary({
    env: {},
    home: HOME,
    platform: "win32",
    io: diskWith([older, newer], ["0.8.0-x86_64", "0.9.0-x86_64"]),
  });
  assert.equal(resolved.bin, newer);
});

test("nothing found anywhere still falls back to the bare name, and SAYS the search failed", () => {
  const resolved = resolveHerdrBinary({ env: {}, home: HOME, platform: "win32", io: diskWith([]) });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.bin, "herdr", "the bare name is still worth trying");
  assert.match(resolved.why, /not on PATH/);
  assert.ok(resolved.tried.length > 0, "a refusal that names nowhere it looked is not a diagnosis");
  assert.ok(resolved.why.includes(resolved.tried[0]), "the message must carry the places tried");
});

test("the platform decides the file name", () => {
  const windows = candidatePaths({ env: {}, home: HOME, platform: "win32", io: diskWith([]) });
  assert.ok(windows.some(candidate => candidate.endsWith("herdr.exe")));
  const linux = candidatePaths({ env: {}, home: HOME, platform: "linux", io: diskWith([]) });
  assert.ok(linux.every(candidate => !candidate.endsWith(".exe")));
});

test("the candidate list is ordered and free of duplicates", () => {
  const candidates = candidatePaths({
    env: { HERDR_BIN_PATH: path.join(STANDALONE, "current", "herdr.exe") },
    home: HOME,
    platform: "win32",
    io: diskWith([]),
  });
  assert.equal(new Set(candidates).size, candidates.length, "a duplicate costs a redundant stat");
  assert.ok(candidates[0].includes("current"), "HERDR_BIN_PATH must be tried first");
});

test("a disk that throws on every question does not crash the resolver", () => {
  const angry = {
    existsSync: () => {
      throw new Error("EACCES");
    },
    readdirSync: () => {
      throw new Error("EACCES");
    },
  };
  const resolved = resolveHerdrBinary({ env: {}, home: HOME, platform: "win32", io: angry });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.bin, "herdr");
});

// THE SECOND DEFECT, reported on WSL: `herdr-aify` refused on a host where `herdr --version` worked,
// having looked only in `~/.herdr/packages/standalone/current`. That is where Herdr's WINDOWS
// installer puts it. Its Linux/macOS installer (`distribution/install.sh`, v0.9.0) writes
// `${HERDR_INSTALL_DIR:-$HOME/.local/bin}/herdr` and nothing under `~/.herdr`. So the search follows
// each installer's own contract, and then PATH, which is what every shell does.

test("Linux: the install.sh default, ~/.local/bin, is found -- the reported case", () => {
  const installed = path.join(LINUX_HOME, ".local", "bin", "herdr");
  const resolved = resolveHerdrBinary({ env: {}, home: LINUX_HOME, platform: "linux", io: diskWith([installed]) });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.bin, installed);
});

test("Linux: the Windows package layout is not searched, so a refusal names real places", () => {
  const tried = candidatePaths({ env: {}, home: LINUX_HOME, platform: "linux", io: diskWith([], ["0.9.0"]) });
  assert.ok(tried.every(candidate => !candidate.includes("packages")), `searched a Windows-only layout: ${tried}`);
});

test("HERDR_INSTALL_DIR replaces the default install directory, as both installers honour it", () => {
  const custom = path.join("/opt", "herdr");
  const tried = candidatePaths({ env: { HERDR_INSTALL_DIR: custom }, home: LINUX_HOME, platform: "linux", io: diskWith([]) });
  assert.equal(tried[0], path.join(custom, "herdr"));
  assert.ok(!tried.includes(path.join(LINUX_HOME, ".local", "bin", "herdr")), "the default is not where this install went");

  const windowsDir = path.join("D:", "Tools", "Herdr");
  const onWindows = candidatePaths({ env: { HERDR_INSTALL_DIR: windowsDir }, home: HOME, platform: "win32", io: diskWith([]) });
  assert.ok(onWindows.includes(path.join(windowsDir, "herdr.exe")));
});

test("Windows: the visible bin under LOCALAPPDATA is searched after the standalone package", () => {
  const localAppData = path.join(HOME, "AppData", "Local");
  const visible = path.join(localAppData, "Programs", "Herdr", "bin", "herdr.exe");
  const tried = candidatePaths({ env: { LOCALAPPDATA: localAppData }, home: HOME, platform: "win32", io: diskWith([]) });
  assert.ok(tried.includes(visible));
  assert.ok(tried.indexOf(path.join(STANDALONE, "current", "herdr.exe")) < tried.indexOf(visible));
});

test("Windows: HERDR_HOME relocates the standalone package root", () => {
  const relocated = path.join("E:", "herdr-home");
  const current = path.join(relocated, "packages", "standalone", "current", "herdr.exe");
  const resolved = resolveHerdrBinary({ env: { HERDR_HOME: relocated }, home: HOME, platform: "win32", io: diskWith([current]) });
  assert.equal(resolved.bin, current);
});

test("a herdr on PATH is found by its full path, after the install locations", () => {
  const brew = path.join("/home", "linuxbrew", ".linuxbrew", "bin");
  const onPath = path.join(brew, "herdr");
  const env = { PATH: ["", "/usr/bin", brew].join(":") };
  const resolved = resolveHerdrBinary({ env, home: LINUX_HOME, platform: "linux", io: diskWith([onPath]) });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.bin, onPath);
  const tried = candidatePaths({ env, home: LINUX_HOME, platform: "linux", io: diskWith([]) });
  assert.ok(tried.indexOf(path.join(LINUX_HOME, ".local", "bin", "herdr")) < tried.indexOf(onPath));
  assert.ok(!tried.includes("herdr"), "an empty PATH entry must not become the bare name");

  const winDir = path.join("C:", "scoop", "shims");
  const onWindows = resolveHerdrBinary({
    env: { Path: [path.join("C:", "Windows"), winDir].join(";") },
    home: HOME,
    platform: "win32",
    io: diskWith([path.join(winDir, "herdr.exe")]),
  });
  assert.equal(onWindows.bin, path.join(winDir, "herdr.exe"), "Windows spells it Path, delimited by ;");
});
