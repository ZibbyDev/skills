/**
 * chunk.mjs — split markdown into ~500–1000 char chunks with a little overlap.
 *
 * Strategy: prefer natural boundaries. We first split on markdown headings so a
 * chunk stays within one section, then pack paragraphs (blank-line separated)
 * into windows of up to MAX_CHARS, starting a new window before a paragraph
 * would overflow. Oversized single paragraphs are hard-split. Consecutive
 * chunks share a small OVERLAP tail so a match near a boundary isn't lost.
 */

const MAX_CHARS = 1000;
const MIN_CHARS = 500; // a soft target — we start a new chunk once we pass this and the next para would overflow
const OVERLAP = 120;

/** Split on ATX headings (## ...), keeping the heading with its section body. */
function splitSections(md) {
  const lines = md.split('\n');
  const sections = [];
  let cur = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && cur.length > 0) {
      sections.push(cur.join('\n'));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) sections.push(cur.join('\n'));
  return sections.length > 0 ? sections : [md];
}

/** Hard-split a string that is itself larger than MAX_CHARS, with overlap. */
function hardSplit(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + MAX_CHARS, text.length);
    out.push(text.slice(i, end));
    if (end >= text.length) break;
    i = end - OVERLAP; // step back for overlap
    if (i < 0) i = 0;
  }
  return out;
}

/** Take the last ~OVERLAP chars of a chunk, snapped to a word boundary. */
function tailOverlap(text) {
  if (text.length <= OVERLAP) return text;
  const tail = text.slice(text.length - OVERLAP);
  const sp = tail.indexOf(' ');
  return sp > 0 ? tail.slice(sp + 1) : tail;
}

/**
 * chunkMarkdown(md) -> string[] of trimmed, non-empty chunks.
 */
export function chunkMarkdown(md) {
  const text = String(md || '').trim();
  if (!text) return [];

  const paragraphs = [];
  for (const section of splitSections(text)) {
    for (const para of section.split(/\n\s*\n/)) {
      const p = para.trim();
      if (p) paragraphs.push(p);
    }
  }

  const chunks = [];
  let buf = '';
  for (const para of paragraphs) {
    // A single paragraph bigger than MAX → flush current buf, hard-split it.
    if (para.length > MAX_CHARS) {
      if (buf) { chunks.push(buf); buf = ''; }
      for (const piece of hardSplit(para)) chunks.push(piece);
      continue;
    }
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (candidate.length > MAX_CHARS && buf) {
      // Adding this para overflows — close the current chunk and start a new
      // one seeded with an overlap tail from the one we just closed.
      chunks.push(buf);
      const seed = tailOverlap(buf);
      buf = `${seed}\n\n${para}`;
    } else {
      buf = candidate;
    }
    // If we've comfortably passed the soft target, opportunistically close so
    // chunks don't all balloon to MAX.
    if (buf.length >= MIN_CHARS && buf.length >= MAX_CHARS) {
      chunks.push(buf);
      buf = '';
    }
  }
  if (buf) chunks.push(buf);

  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
}

export default chunkMarkdown;
