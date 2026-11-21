import fs from "node:fs";
import path from "node:path";

/** Where npm's CLI script sits beside a node: Windows keeps it next to node.exe, a Unix prefix under lib/. */
export function npmCliBeside(execPath) {
  const dir = path.dirname(execPath);
  return [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]
    .find((file) => fs.existsSync(file)) ?? "";
}
