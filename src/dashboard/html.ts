/**
 * Server-side HTML with escaping by default: every interpolated value is escaped unless it is
 * already `Html` (built by this template). Agent output, issue text and logs are untrusted.
 */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Trusted constant markup (the stylesheet). Never pass data to it. */
export const trusted = (constant: string): Html => new Html(constant);

export function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type Part = Html | string | number | boolean | null | undefined | readonly Part[];

function render(p: Part): string {
  if (p === null || p === undefined || p === false) return "";
  if (p instanceof Html) return p.value;
  if (Array.isArray(p)) return (p as readonly Part[]).map(render).join("");
  return esc(String(p));
}

export function html(strings: TemplateStringsArray, ...parts: Part[]): Html {
  let out = strings[0] ?? "";
  parts.forEach((p, i) => {
    out += render(p) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

/** A query string from defined values (keys and values URL-encoded). */
export function query(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}
