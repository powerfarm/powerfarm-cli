const ESC = "\u001b";

const useColor = Boolean(process.stdout.isTTY)
  && !process.env.NO_COLOR
  && process.env.TERM !== "dumb";

const wrap = (open, close) => (text) =>
  useColor ? `${ESC}[${open}m${text}${ESC}[${close}m` : String(text);

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  grey: wrap(90, 39),
};

export const mark = {
  ok: () => style.green("✓"),
  warn: () => style.yellow("!"),
  fail: () => style.red("✗"),
  info: () => style.blue("›"),
};

export function out(line = "") {
  process.stdout.write(`${line}\n`);
}

export function err(line = "") {
  process.stderr.write(`${line}\n`);
}

export function json(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Render rows as an aligned table. `columns` is an array of [key, header]. */
export function table(rows, columns) {
  if (rows.length === 0) return;
  const widths = columns.map(([key, header]) =>
    Math.max(header.length, ...rows.map((row) => String(row[key] ?? "").length)));
  out(columns.map(([, header], i) => style.grey(header.padEnd(widths[i]))).join("  ").trimEnd());
  for (const row of rows) {
    out(columns.map(([key], i) => String(row[key] ?? "").padEnd(widths[i])).join("  ").trimEnd());
  }
}

/** Key/value block with right-aligned labels. */
export function facts(pairs) {
  const width = Math.max(...pairs.map(([label]) => label.length));
  for (const [label, value] of pairs) {
    out(`${style.grey(label.padStart(width))}  ${value}`);
  }
}

export function relativeTime(value) {
  if (!value) return "—";
  const delta = Date.now() - new Date(value).getTime();
  const past = delta >= 0;
  const seconds = Math.abs(delta) / 1000;
  const units = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
  for (const [suffix, size] of units) {
    if (seconds >= size || suffix === "s") {
      const amount = Math.floor(seconds / size);
      return past ? `${amount}${suffix} ago` : `in ${amount}${suffix}`;
    }
  }
  return "—";
}
