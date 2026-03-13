/**
 * 轻量参数解析：支持 --k v 形式。
 */
export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

export function numArg(name, fallback) {
  const v = arg(name, String(fallback));
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
