// Preloaded with `node --import` by wrapper-check-cli.test.js: makes process.stdout asynchronous the way a
// pipe is on POSIX, so a process that exits straight after writing loses what it wrote -- on Windows too,
// where a child's stdout pipe is synchronous (node 22.20, measured: 20 MiB then process.exit(0), read through
// a reader held for a second, arrived whole). A pending timer keeps the event loop alive exactly as a pending
// pipe write does, so a process that lets Node exit by itself still delivers everything.

const write = process.stdout.write.bind(process.stdout);

process.stdout.write = (chunk, encoding, callback) => {
  if (typeof encoding === "function") [callback, encoding] = [encoding, undefined];
  setTimeout(() => write(chunk, encoding, callback), 20);
  return true;
};
