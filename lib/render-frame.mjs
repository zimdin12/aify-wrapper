// Internal Node→Bash transport. The count/terminator preserve fields; NUL is never a value byte.
export function encodeRenderFrame(args) {
  if (!Array.isArray(args) || args.length < 3 || args.some(value => typeof value !== 'string' || value.includes('\0'))
    || args.slice(0, 3).some(value => value === '')) return null;
  return `${args.length}\0${args.join('\0')}\0`;
}
