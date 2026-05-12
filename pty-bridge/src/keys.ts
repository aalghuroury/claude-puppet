// Key-name vocabulary — single source of truth.
// The Python side sends names; this module resolves them to byte sequences.
// Anything not matching <…> syntax is treated as literal text.

const ESC = "\x1b";
const CSI = `${ESC}[`;
const SS3 = `${ESC}O`;

// Extend additively. Keep names lower-case-insensitive on lookup.
const TABLE: Record<string, string> = {
  // basic
  "<enter>": "\r",
  "<return>": "\r",
  "<cr>": "\r",
  "<lf>": "\n",
  "<tab>": "\t",
  "<bs>": "\x7f",
  "<backspace>": "\x7f",
  "<space>": " ",
  "<esc>": ESC,
  "<escape>": ESC,
  "<del>": `${CSI}3~`,

  // arrows
  "<up>": `${CSI}A`,
  "<down>": `${CSI}B`,
  "<right>": `${CSI}C`,
  "<left>": `${CSI}D`,

  // shift+arrows (xterm modifyOtherKeys / standard)
  "<s-up>": `${CSI}1;2A`,
  "<s-down>": `${CSI}1;2B`,
  "<s-right>": `${CSI}1;2C`,
  "<s-left>": `${CSI}1;2D`,

  // navigation
  "<home>": `${CSI}H`,
  "<end>": `${CSI}F`,
  "<pageup>": `${CSI}5~`,
  "<pagedown>": `${CSI}6~`,
  "<insert>": `${CSI}2~`,

  // function keys (xterm)
  "<f1>": `${SS3}P`,
  "<f2>": `${SS3}Q`,
  "<f3>": `${SS3}R`,
  "<f4>": `${SS3}S`,
  "<f5>": `${CSI}15~`,
  "<f6>": `${CSI}17~`,
  "<f7>": `${CSI}18~`,
  "<f8>": `${CSI}19~`,
  "<f9>": `${CSI}20~`,
  "<f10>": `${CSI}21~`,
  "<f11>": `${CSI}23~`,
  "<f12>": `${CSI}24~`,

  // shift-tab
  "<s-tab>": `${CSI}Z`,

  // Bracketed-paste anchors (rare to use directly; bracketedPaste flag is preferred)
  "<paste-start>": `${CSI}200~`,
  "<paste-end>": `${CSI}201~`,
};

// Control chords <C-a>..<C-z> → \x01..\x1a. Special-cased so we don't hand-list 26 entries.
function controlChord(letter: string): string | null {
  if (letter.length !== 1) return null;
  const c = letter.toLowerCase().charCodeAt(0);
  if (c < 0x61 || c > 0x7a) return null;
  return String.fromCharCode(c - 0x60);
}

const NAME_RE = /^<([^>]+)>$/;

/**
 * Resolve a single token (a key-name like "<Enter>" or a literal text fragment) to bytes.
 * Unknown names are returned verbatim with the angle brackets — callers can detect & error.
 */
export function resolveToken(token: string): { bytes: string; resolved: boolean } {
  const m = NAME_RE.exec(token);
  if (!m) return { bytes: token, resolved: true };

  const name = `<${m[1].toLowerCase()}>`;
  if (name in TABLE) return { bytes: TABLE[name], resolved: true };

  // <C-x> control chord
  const ctrlMatch = /^<c-([a-z@\[\\\]\^_?])>$/i.exec(name);
  if (ctrlMatch) {
    const letter = ctrlMatch[1];
    const chord = controlChord(letter);
    if (chord) return { bytes: chord, resolved: true };
    // additional control chars: @ → \0, [ → \x1b, \ → \x1c, ] → \x1d, ^ → \x1e, _ → \x1f, ? → \x7f
    const map: Record<string, string> = {
      "@": "\x00",
      "[": "\x1b",
      "\\": "\x1c",
      "]": "\x1d",
      "^": "\x1e",
      "_": "\x1f",
      "?": "\x7f",
    };
    if (letter in map) return { bytes: map[letter], resolved: true };
  }

  return { bytes: token, resolved: false };
}

/** Resolve a list of tokens. Concatenates bytes and reports any unresolved names. */
export function resolveTokens(tokens: string[]): { bytes: string; unresolved: string[] } {
  const parts: string[] = [];
  const unresolved: string[] = [];
  for (const t of tokens) {
    const r = resolveToken(t);
    parts.push(r.bytes);
    if (!r.resolved) unresolved.push(t);
  }
  return { bytes: parts.join(""), unresolved };
}

/** Wrap a payload in bracketed-paste markers — single Ink redraw rather than N keystroke redraws. */
export function bracketed(payload: string): string {
  return `${CSI}200~${payload}${CSI}201~`;
}

/** Names exposed for the Python side to validate against (test_keys_vocab). */
export function knownNames(): string[] {
  const names = Object.keys(TABLE);
  // Add the control-chord templates
  for (const c of "abcdefghijklmnopqrstuvwxyz") names.push(`<c-${c}>`);
  for (const c of "@[\\]^_?".split("")) names.push(`<c-${c}>`);
  return names.sort();
}
