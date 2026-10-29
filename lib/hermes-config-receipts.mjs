// What the hermes config step last wrote into each hermes config, as hermes read it back: per config target, per
// entry, the digest of the value written and of hermes' `config get` answer for it after (lib/hermes-config-install.mjs
// `entryReceipt`). The plan takes an entry for current only when both still match, so the receipt never stands in for
// the config: it says what hermes answered then, and hermes' answer now is compared against it.
//
// Keyed by the config target, so a receipt for one HERMES_HOME says nothing about another. Digests only: an entry can
// carry a service's key, and none is kept here. Anything unreadable reads as no receipt, which costs one rewrite.

import fs from "node:fs";
import path from "node:path";

/** The receipts' place under a home: `~/.aify/hermes-config-receipts.json`. */
export function receiptsPath(home) {
  return path.join(home, ".aify", "hermes-config-receipts.json");
}

/** One file of receipts, keyed by hermes config target. */
export class HermesConfigReceipts {
  constructor({ file, io = fs, platform = process.platform }) {
    this.file = file;
    this.io = io;
    // A config is one file case-insensitively on Windows, as hermes-pending-config.mjs `sameTarget` reads it.
    this.key = (target) => (platform === "win32" ? path.resolve(target).toLowerCase() : path.resolve(target));
  }

  /** The receipts for `target`'s entries, `{}` when there are none or the file cannot be read. */
  read(target) {
    const found = this.#all()[this.key(target)];
    return found && typeof found === "object" ? found : {};
  }

  /** Replace `target`'s receipts with `receipts`, leaving every other config's. Owner-only, renamed into place. */
  write(target, receipts) {
    const all = { ...this.#all(), [this.key(target)]: receipts };
    this.io.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    this.io.writeFileSync(temp, `${JSON.stringify({ version: 1, targets: all }, null, 2)}\n`, { mode: 0o600 });
    this.io.renameSync(temp, this.file);
  }

  #all() {
    try {
      const body = JSON.parse(String(this.io.readFileSync(this.file, "utf8")));
      return body?.version === 1 && body.targets && typeof body.targets === "object" ? body.targets : {};
    } catch {
      return {};
    }
  }
}
