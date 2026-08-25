/**
 * EVERY OUTBOUND HTTP DOOR IN THIS PACKAGE IS BOUNDED — the rule, not the
 * instances.
 * ============================================================================
 *
 * Node's global `fetch` has NO default timeout and A HANG IS NOT A THROW, so a
 * provider that accepts a connection and never answers is not an error any
 * `catch` can see — it is a tool call that never returns, inside a run that is
 * waiting on it, until the container watchdog kills the whole thing. Measured
 * at 7m33s on board-runner run 4b49371e (2026-08-24), through a door one layer
 * up. This package was the LAST and WIDEST layer of that class: ~45 call sites
 * across ~25 provider modules.
 *
 * ⚠️ THE SOURCE TRIPWIRE IS THE POINT OF THIS FILE. Behavioural tests pin the
 * doors that exist the day they are written; a source scan pins the RULE, so
 * door #46 fails the suite the day it is WRITTEN rather than the day it hangs
 * somebody's run. A pin without an assert is a wish.
 *
 * ⚠️ AND THE PROBE IS VALIDATED BEFORE ITS SILENCE COUNTS. A scan that matched
 * nothing would pass VACUOUSLY — the exact failure mode this whole class of bug
 * has been hiding behind. So the first test asserts the scanner still FINDS the
 * bounded doors (a positive control), the second asserts it can still SEE an
 * unbounded one (a negative control, on a fixture), and only then does the
 * third one's silence about the real tree mean anything.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The one module allowed to call the global `fetch` — it IS the bound. */
const THE_DOOR = 'lib/http-deadline.ts';

/**
 * STRIP STRINGS AND COMMENTS FIRST, replacing them with spaces so every byte
 * offset (and therefore every reported line number) survives.
 *
 * Not fastidiousness — a MEASURED false positive. `datasetStore.ts` describes a
 * tool argument as "the relative file path to fetch (as listed by file_list)",
 * and a naive `/fetch\s*\(/` scan reports that prose as an unbounded network
 * call. A tripwire with a known false positive is a tripwire people learn to
 * skim past, which is the same as not having one.
 */
export function stripLiterals(src: string): string {
  const out = src.split('');
  /** Blank a range, keeping newlines so every reported line number survives. */
  const blank = (from: number, to: number) => {
    for (let k = Math.max(0, from); k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  // `${…}` holds REAL CODE — a fetch call can live inside one — so a template
  // is not one literal but an alternation of text (blanked) and code (kept).
  // `tplBraces` remembers, for each open substitution, the brace depth we
  // return to the template's text at.
  const tplBraces: number[] = [];
  let depth = 0;
  let i = 0;

  /** Consume template TEXT from `from`; returns the index to resume scanning at. */
  const eatTemplateText = (from: number): number => {
    let j = from;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { blank(from, j + 1); return j + 1; }
      if (src[j] === '$' && src[j + 1] === '{') {
        blank(from, j);
        tplBraces.push(depth);
        depth += 1;
        return j + 2;
      }
      j += 1;
    }
    blank(from, src.length);
    return src.length;
  };

  // Is the `/` at `i` the start of a REGEX literal rather than a division? The
  // standard heuristic: look back at the last meaningful char. This is not
  // pedantry — `plane-adapter.ts` really does contain `/[()\-_:："'`]/g`, whose
  // quote and BACKTICK would otherwise open a string that swallows the rest of
  // the file, and a scanner that silently swallows a file is exactly the
  // "negative result you did not verify" this tripwire exists to prevent.
  const regexCanStartHere = (at: number): boolean => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(src[k])) k -= 1;
    if (k < 0) return true;
    const c = src[k];
    if ('([{,;:=!&|?+-*%^~<>'.includes(c)) return true;
    if (/[\w$)\]]/.test(c)) {
      const word = /[A-Za-z_$][\w$]*$/.exec(src.slice(0, k + 1))?.[0];
      return !!word && ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await'].includes(word);
    }
    return true;
  };

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && regexCanStartHere(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') break;               // not a regex after all
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j += 1;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c || src[j] === '\n') break;
        j += 1;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
    } else if (c === '`') {
      i = eatTemplateText(i + 1);
    } else if (c === '{') {
      depth += 1;
      i += 1;
    } else if (c === '}') {
      depth -= 1;
      i += 1;
      // Closing the `${…}` we opened ⇒ back into the template's text.
      if (tplBraces.length && depth === tplBraces[tplBraces.length - 1]) {
        tplBraces.pop();
        i = eatTemplateText(i);
      }
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** Every `fetch(` / `fetchWithDeadline(` call site, with its argument text. */
export function callSites(source: string, name: 'fetch' | 'fetchWithDeadline') {
  const code = stripLiterals(source);
  const out: Array<{ line: number; args: string }> = [];
  const re = new RegExp(`(?<![.\\w])${name}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    out.push({
      line: code.slice(0, m.index).split('\n').length,
      // Args come from the ORIGINAL source so a `signal` inside a literal is
      // still visible to the assertion; only the SITE was found on stripped code.
      args: source.slice(re.lastIndex, i - 1),
    });
  }
  return out;
}

/**
 * Every module in this package that can talk to the network. The whole of
 * `src/` minus its tests — an allowlist would be the bug: a NEW provider file
 * nobody remembered to list is precisely door #46.
 */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === '__tests__' || e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (['.ts', '.js', '.mjs'].includes(extname(e)) && !e.endsWith('.d.ts') && !/\.(test|spec)\./.test(e)) out.push(p);
  }
  return out;
}

const FILES = sourceFiles().map((p) => ({ rel: relative(SRC, p), src: readFileSync(p, 'utf8') }));

describe('the probe can see', () => {
  it('finds the bounded doors it is supposed to find (positive control)', () => {
    const bounded = FILES.reduce((n, f) => n + callSites(f.src, 'fetchWithDeadline').length, 0);
    // 46 the day this landed. A DROP means the scanner stopped resolving call
    // sites and every assertion below went vacuous.
    expect(bounded).toBeGreaterThanOrEqual(40);
    // …and across many modules, not all in one file.
    const modules = FILES.filter((f) => callSites(f.src, 'fetchWithDeadline').length > 0);
    expect(modules.length).toBeGreaterThanOrEqual(20);
  });

  it('still sees an UNBOUNDED fetch when there is one (negative control)', () => {
    const fixture = `
      export async function leak(url) {
        const res = await fetch(url, { method: 'GET', headers: {} });
        return res.json();
      }
    `;
    const sites = callSites(fixture, 'fetch');
    expect(sites).toHaveLength(1);
    expect(/\bsignal\b/.test(sites[0].args)).toBe(false);
  });

  it('is NOT fooled by prose or by a string that says "fetch("', () => {
    const fixture = [
      '// call fetch(url) here one day',
      '/* fetch(url) in a block comment */',
      "const help = 'the relative file path to fetch (as listed by file_list)';",
      'const tpl = `see fetch(x) in the docs`;',
      'const real = await fetch(u, { signal: s });',
    ].join('\n');
    const sites = callSites(fixture, 'fetch');
    expect(sites).toHaveLength(1);
    expect(sites[0].line).toBe(5);
  });

  it('still finds a real fetch inside a template substitution', () => {
    const sites = callSites('const s = `${await fetch(u, { signal: x })}`;', 'fetch');
    expect(sites).toHaveLength(1);
  });
});

describe('every outbound HTTP door in @zibby/skills is bounded', () => {
  it('no module calls the global fetch except the helper that bounds it', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      if (rel === THE_DOOR) continue;
      for (const site of callSites(src, 'fetch')) {
        // A hand-rolled AbortController is still a bound (gbrain.ts predates
        // the helper and owns a retry loop keyed on its own abort), so the RULE
        // is "carries a signal", not "imports the helper". What it may never be
        // is neither.
        if (!/\bsignal\b/.test(site.args)) offenders.push(`${rel}:${site.line}`);
      }
    }
    expect(offenders, [
      'UNBOUNDED fetch(). Node has no default fetch timeout, so this hangs a run',
      'rather than failing it. Route it through lib/http-deadline.ts:',
      "  import { fetchWithDeadline } from './lib/http-deadline.js';",
      "  await fetchWithDeadline(url, init, { kind: 'api', what: 'Provider GET /x' });",
      "kind: 'api' (30s, far end reads a row) | 'transfer' (120s, size is the",
      "variable) | 'job' (300s, far end computes).",
    ].join('\n')).toEqual([]);
  });

  it('every bounded door declares WHAT it is, so a timeout log names the call', () => {
    const nameless: string[] = [];
    for (const { rel, src } of FILES) {
      // The helper's own `export async function fetchWithDeadline(` reads as a
      // call site to a scanner that matches on name + parens. It is the
      // DEFINITION, not a door.
      if (rel === THE_DOOR) continue;
      for (const site of callSites(src, 'fetchWithDeadline')) {
        if (!/\bwhat\s*:/.test(site.args)) nameless.push(`${rel}:${site.line}`);
      }
    }
    expect(nameless, 'a timeout that says only "request TIMED OUT" makes all 46 doors look identical in a run log').toEqual([]);
  });
});
