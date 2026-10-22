# Mutants for the final-verdict repairs (S1-S6) on top of 30047ce. Each arm edits one site in one lib file, runs the
# focused channel tests, and restores the file from a byte copy, checked equal. Usage: python mutate-final.py <root>
import hashlib, os, shutil, subprocess, sys

root = sys.argv[1]
tests = ["tests/the-route-declines-what-it-cannot-resolve.test.js", "tests/a-channel-server-is-judged-by-what-it-runs.test.js",
         "tests/the-windows-policy-is-read-and-written-exactly.test.js", "tests/the-channel-route-reads-every-channel-the-session-runs.test.js"]
arms = [
  ("S1 Settings matched with case", "channel-policy.mjs", 'name.toLowerCase() === "settings"', 'name === "Settings"'),
  ("S2 drop-ins do not answer for an admitting base", "channel-policy.mjs", 'if (answer.source.kind === "file" && dropIns) return dropIns;', ""),
  ("S2 empty HKLM read as absent", "channel-policy.mjs", '(source.kind === "registry" && source.admin)', "false"),
  ("S3 a missing dev script still a provider", "channel-route.mjs", "readScript(c.entry) === null", "false"),
  ("S3 a record with no command still a provider", "channel-route.mjs", 'if (c.form === "invalid")', "if (false)"),
  ("S3 a dev provider routed to the plugin still a provider", "channel-route.mjs", 'if (c.route === "plugin")', "if (false)"),
  ("S3 a path Claude expands read as a missing file", "channel-route.mjs", "entry !== null && /\\$\\{|^~/.test(entry)", "false"),
  ("S3 an empty strict MCP input keeps dev", "channel-route-cli.mjs", "if (strict.known && !strict.usable) return", "if (false) return"),
  ("S4 script taken from anywhere in the arguments", "channel-route.mjs",
   "script: !expands && entry !== null && CHANNEL_SCRIPT.test(entry) ? entry : null,",
   "script: (Array.isArray(s?.args) ? s.args.find((a) => CHANNEL_SCRIPT.test(String(a))) : null) ?? null,"),
  ("S5 a consumer's own route ignored", "channel-route.mjs", "if (conflicts(consumer.route, \"plugin\")) {", "if (false) {"),
  ("S5 the plugin server's own route ignored", "channel-route.mjs", "if (conflicts(ownRoute(server), \"plugin\")) {", "if (false) {"),
  ("S5 a matching route treated as a conflict", "channel-route.mjs", "own !== undefined && own !== route", "own !== undefined"),
  ("S6 extra manifest servers accepted", "channel-route.mjs", "Object.keys(servers).length !== 1", "false"),
  ("S6 a plugin .mcp.json accepted", "channel-route.mjs", "if (pluginMcpText !== null && pluginMcpText !== undefined) {", "if (false) {"),
  ("S6 an unreadable file read as absent", "channel-route.mjs",
   'return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? null : { unreadable: `${file}', "return true ? null : { unreadable: `${file}"),
  ("S6 an install for another scope accepted", "channel-route.mjs", 'if (!entries.some((e) => e?.scope === "user")) return', "if (false) return"),
  ("S6 project and local settings not read", "channel-route.mjs", "for (const text of [settingsText, ...settingsTexts])", "for (const text of [settingsText])"),
]

def run():
    r = subprocess.run("npm test -- " + " ".join(tests), cwd=root, shell=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, [l.strip() for l in r.stdout.splitlines() if l.lstrip().startswith("not ok")]

print("baseline", run())
for name, file, old, new in arms:
    lib = os.path.join(root, "lib", file)
    keep = lib + ".mutant-keep"
    assert open(lib, "rb").read().decode("utf-8").count(old) == 1, (name, open(lib, "rb").read().decode("utf-8").count(old))
    shutil.copyfile(lib, keep)
    orig = open(keep, "rb").read()
    text = orig.decode("utf-8")
    try:
        open(lib, "wb").write(text.replace(old, new).encode("utf-8"))
        code, fails = run()
    finally:
        shutil.copyfile(keep, lib)
        os.remove(keep)
    assert open(lib, "rb").read() == orig, name
    print("KILLED" if code != 0 else "SURVIVED", name, "exit", code, "|", " ; ".join(fails)[:300])
for f in ["channel-route.mjs", "channel-route-cli.mjs", "channel-policy.mjs"]:
    print("restored", f, hashlib.sha256(open(os.path.join(root, "lib", f), "rb").read()).hexdigest()[:16])
