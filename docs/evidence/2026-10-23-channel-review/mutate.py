# Mutants for the 2026-10-23 review fixes. Each arm edits one site in one lib file, runs the focused tests, and
# restores the file from a byte copy, checked equal. Usage: python mutate.py <repo-root>
import hashlib, os, shutil, subprocess, sys

root = sys.argv[1]
tests = ["tests/a-channel-server-is-judged-by-what-it-runs.test.js", "tests/the-windows-policy-is-read-and-written-exactly.test.js",
         "tests/the-channel-route-reads-every-channel-the-session-runs.test.js"]
arms = [
  ("R1 Settings matched with case", "channel-policy.mjs", 'name.toLowerCase() === "settings"', 'name === "Settings"'),
  ("R2 two spellings not refused", "channel-policy.mjs", "if (isSettings && found !== undefined) return", "if (false) return"),
  ("R3 script taken from anywhere in the arguments", "channel-route.mjs",
   "script: entry !== null && CHANNEL_SCRIPT.test(entry) ? entry : null,",
   "script: (Array.isArray(s?.args) ? s.args.find((a) => CHANNEL_SCRIPT.test(String(a))) : null) ?? null,"),
  ("R4 a server's own route ignored", "channel-route.mjs", "if (consumer.route !== undefined) {", "if (false) {"),
  ("R5 the plugin server's own route ignored", "channel-route.mjs", "if (ownRoute(server) !== undefined) {", "if (false) {"),
  ("R6 the route variable matched with case", "channel-route.mjs", "key.toUpperCase() === ROUTE_VARIABLE", "key === ROUTE_VARIABLE"),
]

def run():
    r = subprocess.run("npm test -- " + " ".join(tests), cwd=root, shell=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, [l.strip() for l in r.stdout.splitlines() if l.lstrip().startswith("not ok")]

print("baseline", run())
for name, file, old, new in arms:
    lib = os.path.join(root, "lib", file)
    keep = lib + ".mutant-keep"
    shutil.copyfile(lib, keep)
    orig = open(keep, "rb").read()
    text = orig.decode("utf-8")
    assert text.count(old) == 1, (name, text.count(old))
    try:
        open(lib, "wb").write(text.replace(old, new).encode("utf-8"))
        code, fails = run()
    finally:
        shutil.copyfile(keep, lib)
        os.remove(keep)
    assert open(lib, "rb").read() == orig, name
    print("KILLED" if code != 0 else "SURVIVED", name, "exit", code, "|", " ; ".join(fails)[:300])
print("restored", hashlib.sha256(open(os.path.join(root, "lib", "channel-route.mjs"), "rb").read()).hexdigest()[:16],
      hashlib.sha256(open(os.path.join(root, "lib", "channel-policy.mjs"), "rb").read()).hexdigest()[:16])
