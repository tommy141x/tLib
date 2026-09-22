// GTA's ~colour~ markup, parsed. Deliberately free of every import: no solid-js,
// no i18n, nothing reactive. These two functions are pure string work, and the
// Playwright runner loads them from a CommonJS context where
// @solid-primitives/i18n cannot be resolved at all -- it publishes only an
// `import` condition in its exports map, so a `require` of anything that reaches
// it throws "No exports main defined" and takes the whole browser suite down with
// it. Keeping the parser separate from the translator is also just the honest
// split: text.tsx re-exports both names, so every existing call site is unchanged.

const colors: Record<string, string> = {
  r: "#e03232",
  g: "#72cc72",
  b: "#5db6e5",
  y: "#f0c850",
  p: "#8466e2",
  o: "#ff8555",
  c: "#9a9a9a",
  m: "#646464",
  u: "#000000",
  w: "#ffffff",
};

// GTA formatting is presentation, never HTML. Unknown control tokens are not read
// aloud or searched, and text is always escaped by Solid's normal renderer.
export function plainText(text: string | undefined): string {
  return (text ?? "").replace(/~n~/gi, "\n").replace(/~[^~\r\n]+~/g, "");
}

export function formattedParts(text: string | undefined) {
  let color: string | undefined;
  let bold = false,
    italic = false;
  const parts: { text: string; color?: string; bold: boolean; italic: boolean }[] = [];
  for (const part of (text ?? "").split(/(~[^~\r\n]+~)/g)) {
    if (part.startsWith("~") && part.endsWith("~") && part.length > 2) {
      const token = part.slice(1, -1).toLowerCase();
      if (token === "s") {
        color = undefined;
        bold = false;
        italic = false;
      } else if (token === "italic") italic = !italic;
      else if (token === "h") bold = !bold;
      else if (token === "n") parts.push({ text: "\n", color, bold, italic });
      else if (colors[token]) color = colors[token];
    } else if (part) parts.push({ text: part, color, bold, italic });
  }
  return parts;
}
