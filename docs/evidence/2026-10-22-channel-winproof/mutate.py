# Mutation campaign for the Windows policy adapters. Each arm edits one site, runs the two policy test files,
# records the result, and restores lib/channel-policy.mjs from a byte copy. Usage: python mutate.py <repo-root>
import shutil, subprocess, sys, hashlib, os
root = sys.argv[1]
lib = os.path.join(root, "lib", "channel-policy.mjs")
keep = lib + ".mutant-keep"
shutil.copyfile(lib, keep)
orig = open(keep, "rb").read()
h = lambda b: hashlib.sha256(b).hexdigest()[:16]
arms = {
  "M1 writer replaces the key (New-Item -Force)": ('"$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:AIFY_CHANNEL_POLICY_SUBKEY); "',
      '"New-Item -Path (\'HKCU:\\\' + $env:AIFY_CHANNEL_POLICY_SUBKEY) -Force | Out-Null; $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:AIFY_CHANNEL_POLICY_SUBKEY, $true); "'),
  "M2 every export failure read as absent": ("return NOT_FOUND.test(said) ? null :", "return true ? null :"),
  "M3 a Settings of another type read as absent": ('if (name === "Settings") return { unreadable: `${key} Settings is not a plain string (REG_SZ)` };', 'if (name === "Settings") return null;'),
  "M4 escapes not decoded": ("        out += next;\n        at += 1;", "        out += ch;"),
  "M5 an unreadable admin file read as absent": ('return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? null : { unreadable: `${source.path}', 'return true ? null : { unreadable: `${source.path}'),
  "M6 parsePolicy does not name an unreadable source": ("if (isPlainObject(text) && text.unreadable) return", "if (false) return"),
  "M7 drop-in policy files read as absent": ("return drops.length ? { unreadable:", "return false ? { unreadable:"),
  "M8 the drop-in directory not an admin source": ('      inProgramFiles("dir", "managed-settings.d"),\n', ""),
}
tests = ["tests/the-windows-policy-is-read-and-written-exactly.test.js", "tests/the-channel-policy-is-merged-never-overwritten.test.js"]
def run():
    r = subprocess.run("npm test -- " + " ".join(tests), cwd=root, shell=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
    fails = [l for l in r.stdout.splitlines() if l.startswith("not ok") or l.startswith("    not ok")]
    return r.returncode, fails
print("baseline", h(orig), run())
for name, (old, new) in arms.items():
    text = orig.decode("utf-8")
    assert text.count(old) == 1, (name, text.count(old))
    open(lib, "wb").write(text.replace(old, new).encode("utf-8"))
    code, fails = run()
    shutil.copyfile(keep, lib)
    assert open(lib, "rb").read() == orig
    print(("KILLED" if code != 0 else "SURVIVED"), name, "exit", code, "|", " ; ".join(f.strip() for f in fails)[:300])
os.remove(keep)
print("restored", h(open(lib, "rb").read()) == h(orig))
