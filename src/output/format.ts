export interface Colors {
  red: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
  cyan: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

const ESC = String.fromCharCode(27);

const wrap = (open: number, close: number) => (s: string) => `${ESC}[${open}m${s}${ESC}[${close}m`;

const identity = (s: string) => s;

export function colorizer(enabled: boolean): Colors {
  if (!enabled) {
    return {
      red: identity,
      yellow: identity,
      green: identity,
      cyan: identity,
      dim: identity,
      bold: identity,
    };
  }
  return {
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    green: wrap(32, 39),
    cyan: wrap(36, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
  };
}

export function colorEnabled(
  noColorFlag: boolean,
  env: Record<string, string | undefined>,
  isTTY: boolean,
): boolean {
  if (noColorFlag) return false;
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  return isTTY;
}

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Visible width of a string, ignoring ANSI escapes. */
export function visibleLength(s: string): number {
  return s.replace(ANSI_PATTERN, '').length;
}

/** Render an aligned table. Returns lines (no trailing newline). */
export function renderTable(header: string[], rows: string[][]): string[] {
  const all = [header, ...rows];
  const widths: number[] = header.map((_, col) =>
    Math.max(...all.map((r) => visibleLength(r[col] ?? ''))),
  );
  const pad = (cell: string, w: number) => cell + ' '.repeat(w - visibleLength(cell));
  const line = (r: string[]) =>
    r
      .map((cell, i) => pad(cell, widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

export function toJsonString(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

/** Truncate to a visible width, appending an ellipsis when cut. */
export function truncate(s: string, max: number): string {
  if (visibleLength(s) <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
