// What a listed process runs, as the OS states it: its IMAGE (the program file's name) and its ARGV as a list, or null
// for either one that could not be read. lib/process-identity.mjs's table carries both beside `commandLine`.
//
// WHY BOTH. A command line split on spaces loses its boundaries: a program under a path with a space, or an option
// that takes a value, moved the token a matcher reads (review of ba87799, which found a running hermes granted a
// quiet host). The image is reported whole by the OS on every platform, so the program is named from it. An unreadable
// command line is null, never an empty one, so a caller can tell "nothing to read" from "could not read".

/** The program's name, lower case and without `.exe`: `C:\x\Hermes.EXE` and `hermes` are both `hermes`. PURE. */
export function imageName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
  return base === "" ? null : base;
}

/**
 * A Windows command line as the argv a C program receives, by the rules CommandLineToArgvW documents. PURE.
 * The program name is everything up to the first space, or between its quotes, with no escapes. After it, 2n
 * backslashes before a quote are n backslashes and the quote toggles quoting; 2n+1 are n and a literal quote; a
 * quote inside quotes followed by another is one literal quote; backslashes elsewhere are literal.
 */
export function windowsArgv(commandLine) {
  const text = String(commandLine ?? "");
  const argv = [];
  let at = 0;
  while (text[at] === " " || text[at] === "\t") at += 1;
  if (at >= text.length) return argv;
  let program = "";
  if (text[at] === '"') {
    const close = text.indexOf('"', at + 1);
    program = close === -1 ? text.slice(at + 1) : text.slice(at + 1, close);
    at = close === -1 ? text.length : close + 1;
  } else {
    while (at < text.length && text[at] !== " " && text[at] !== "\t") program += text[at++];
  }
  argv.push(program);
  for (;;) {
    while (text[at] === " " || text[at] === "\t") at += 1;
    if (at >= text.length) return argv;
    let arg = "";
    let quoted = false;
    while (at < text.length && (quoted || (text[at] !== " " && text[at] !== "\t"))) {
      if (text[at] === "\\") {
        let slashes = 0;
        while (text[at] === "\\") { slashes += 1; at += 1; }
        if (text[at] === '"') {
          arg += "\\".repeat(Math.floor(slashes / 2));
          if (slashes % 2) { arg += '"'; at += 1; }
        } else {
          arg += "\\".repeat(slashes);
        }
      } else if (text[at] === '"') {
        if (quoted && text[at + 1] === '"') { arg += '"'; at += 2; } else { quoted = !quoted; at += 1; }
      } else {
        arg += text[at++];
      }
    }
    argv.push(arg);
  }
}

/**
 * A Linux process's image (stat's comm, between its first `(` and last `)`) and argv (cmdline's NUL-separated
 * words). A cmdline that is gone throws, so the row is dropped as a process that ended; one that cannot be read for
 * any other reason gives a null argv and command line, never an empty one.
 */
export function linuxCommand(pid, stat, readFile) {
  const text = String(stat ?? "");
  const image = imageName(text.slice(text.indexOf("(") + 1, text.lastIndexOf(")")));
  let raw;
  try {
    raw = String(readFile(`/proc/${pid}/cmdline`, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    return { image, argv: null, commandLine: null };
  }
  const argv = raw.split("\0");
  if (argv.at(-1) === "") argv.pop();
  return { image, argv, commandLine: argv.join(" ").trim() };
}
