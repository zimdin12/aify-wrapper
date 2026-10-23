// `aify-wrapper-connect` arguments, parsed. PURE, so the rules are testable without a connect.
//
// A KEY NEVER TRAVELS IN ARGV: every process on the host can read the process table for as long as the command
// runs. Keys come from a file (`--key-file`, `--secret-file <field>=<file>`) or from stdin (`--key-stdin`), and a
// flag that would carry one is refused by name rather than ignored -- the rule aify-env's credential command keeps.

export const USAGE = [
  "usage: aify-wrapper-connect <service> <url> [options]",
  "  --key-file <file>              the service key (its credentialRef), read from a file",
  "  --key-stdin                    the service key, read from stdin",
  "  --secret-file <field>=<file>   another declared secret, e.g. secretsCredentialRef=<file>",
  "  --approve <digest>             approve one artifact tuple, exactly as the refusal printed it",
  "  --no-prompt                    never ask; anything that needs a person fails",
  "  --registry <path>              the registry (default: $AIFY_SERVICE_REGISTRY or ~/.aify/services.json)",
  "  --dest <dir>                   where the launchers are (default: ~/.local/bin)",
  "  --aify-env <path>              aify-env's bin/aify-env.mjs (default: under `npm root -g`)",
  "  --npm-root <dir>               npm's global root, instead of asking npm",
  "  --file-set-root <dir>          where a file-set artifact is installed (default: ~/.<service>/mcp/stdio)",
  "  --package-root <dir>           where a package artifact's revisions are installed (default: ~/.aify/packages)",
  "  --npm-cli <path>               npm's bin/npm-cli.js (default: the one beside this node)",
  "  --report-file <path>           also write what was installed, as JSON, to <path>, which must not exist",
].join("\n");

const VALUED = ["--key-file", "--secret-file", "--approve", "--registry", "--dest", "--aify-env", "--npm-root", "--file-set-root", "--package-root", "--npm-cli", "--report-file"];

export function parseConnectArgs(argv) {
  const out = { positional: [], keyFile: "", keyStdin: false, secretFiles: {}, approve: [], noPrompt: false, problem: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (/^--(key|value|secret|password|token)(=|$)/.test(arg)) {
      out.problem = `${arg.split("=")[0]} would put a key in argv, where every process on this host can read it; use --key-file or --key-stdin`;
      return out;
    }
    if (arg === "--key-stdin") { out.keyStdin = true; continue; }
    if (arg === "--no-prompt") { out.noPrompt = true; continue; }
    if (VALUED.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || String(value).startsWith("--")) { out.problem = `${arg} needs a value`; return out; }
      i += 1;
      if (arg === "--key-file") out.keyFile = value;
      else if (arg === "--approve") out.approve.push(value);
      else if (arg === "--secret-file") {
        const at = value.indexOf("=");
        if (at < 1) { out.problem = "--secret-file takes <field>=<file>"; return out; }
        out.secretFiles[value.slice(0, at)] = value.slice(at + 1);
      } else out[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      continue;
    }
    if (arg.startsWith("--")) { out.problem = `unknown option ${arg}`; return out; }
    out.positional.push(arg);
  }
  if (out.positional.length !== 2) out.problem = "name the service and its url";
  else if (out.keyFile && out.keyStdin) out.problem = "--key-file and --key-stdin are two answers to one question; give one";
  else if (Object.hasOwn(out.secretFiles, "credentialRef")) out.problem = "the service key is --key-file or --key-stdin";
  else {
    try {
      const url = new URL(out.positional[1]);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      out.problem = `${out.positional[1]} is not an http(s) url without credentials`;
    }
  }
  return out;
}

/** A key from a file or stdin: exactly one trailing line ending removed, nothing else (aify-env keyFromStdin). */
export function keyFromText(text) {
  const value = String(text ?? "");
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}
