// Which lines of a shell script run a command while WRITING a file, rather than when the file is run.
//
// A heredoc whose delimiter is unquoted (`<<EOF`, not `<<'EOF'`) is expanded by the shell as it is
// written. `$VAR` and `$(cmd)` there are usually deliberate -- that is how install.sh bakes an
// endpoint into a launcher. A BACKTICK almost never is: it is command substitution wearing the
// costume of a quotation mark, and it appears in prose far more often than in code.
//
// WHAT THIS DOES NOT PROVE, stated because the name invites the wrong reading: it does not prove a
// heredoc executes nothing. `$(...)` and variable expansion stay executable by design. The claim is
// narrower and worth exactly what it says -- markdown-style punctuation cannot become a command.
//
// TERMINATOR RECOGNITION IS SHELL SEMANTICS, NOT `.trim()`. The first version trimmed each line and
// compared, and a reviewer's executed mutant took it apart in one go:
//
//     cat <<EOF
//       EOF
//     `printf danger`
//     EOF
//
// For a plain `<<EOF` the indented `  EOF` is BODY. The scanner ended the heredoc there, walked past
// the live backticks as ordinary script, and returned a clean `[]`. Verified before accepting: it
// returned `[]`, and returns two findings now. Only `<<-WORD` strips indentation, and only TABs.
//
// Pure, and it takes text rather than a path, so a caller can drive it over fixtures carrying the
// exact shapes this is meant to catch. A scanner proven only against the file it was written for
// cannot tell an absence from a broken instrument.
//
// IT LIVES HERE BECAUSE THIS REPO OWNS THE TEMPLATES. A consumer must ask the same question about the
// bytes its pin resolved to and about what it renders from them, and two hand-written scanners agree
// only until one of them is fixed. One implementation, two roles: this repo scans its own source, a
// consumer scans the pinned package and its rendered output. It ships in `files`, so a consumer
// imports `aify-wrapper/lib/heredoc-scan.mjs` rather than keeping a copy.

const BACKTICK = String.fromCharCode(96);
const BACKSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);

// `<<-'WORD'`, `<<"WORD"`, `<<WORD`. The quote decides whether the body is expanded; the dash decides
// whether leading tabs are stripped before the terminator is matched.
const OPENER = /<<(?<dash>-)?\s*(?<quote>['"])?(?<word>[A-Za-z_][A-Za-z0-9_]*)\k<quote>?/;

/**
 * @typedef {{line: number, text: string, delimiter: string}} Finding
 *   `line` is 1-indexed, so it pastes straight into a `file:line` reference.
 * @typedef {{backticks: Finding[], unterminated: {line: number, delimiter: string}[]}} Scan
 */

/** Is this line the terminator for a heredoc opened with `word`? */
function isTerminator(line, word, dash) {
  // `<<-` strips leading TABS ONLY. Spaces never count, for either form.
  const candidate = dash ? line.replace(new RegExp(`^${TAB}+`), "") : line;
  return candidate === word;
}

/**
 * Backticks inside unquoted heredoc bodies, and any heredoc that never ends.
 *
 * AN UNTERMINATED HEREDOC IS A SCANNER FAILURE, not a clean scan. Reaching end-of-file without the
 * delimiter means the walk lost the file's structure, and everything it said after that point is
 * guesswork. Reporting zero findings there would be the false green this whole file exists to stop.
 *
 * @param {string} source  the whole script
 * @returns {Scan}
 */
export function scanHeredocs(source) {
  const lines = String(source ?? "").split("\n");
  const backticks = [];
  const unterminated = [];
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].includes("<<") ? OPENER.exec(lines[i]) : null;
    if (!match) { i += 1; continue; }
    const { dash, quote, word } = match.groups;
    let end = i + 1;
    while (end < lines.length && !isTerminator(lines[end], word, Boolean(dash))) end += 1;
    if (end >= lines.length) unterminated.push({ line: i + 1, delimiter: word });
    if (!quote) {
      for (let k = i + 1; k < Math.min(end, lines.length); k += 1) {
        for (let c = 0; c < lines[k].length; c += 1) {
          if (lines[k][c] !== BACKTICK) continue;
          // An ESCAPED backtick is inert, and is how a launcher legitimately prints one.
          if (c > 0 && lines[k][c - 1] === BACKSLASH) continue;
          backticks.push({ line: k + 1, text: lines[k].trim(), delimiter: word });
          break;
        }
      }
    }
    i = end;
  }
  return { backticks, unterminated };
}

/** Just the backticks, for a caller that has already established the file parses. */
export function backticksInUnquotedHeredocs(source) {
  return scanHeredocs(source).backticks;
}
