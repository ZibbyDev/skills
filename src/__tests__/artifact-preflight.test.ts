/**
 * artifact_publish PRE-FLIGHT tests — the local data↔render check, driven through
 * the REAL handler with the network mocked.
 *
 * THE ASSERTION THAT MATTERS is not "it returned an error" — it is that the
 * broken page NEVER REACHED THE WIRE. A pre-flight that refuses after POSTing is
 * not a pre-flight, and the difference is invisible in the returned JSON. So
 * every broken-fixture case asserts `fetch` was called ZERO times.
 *
 * The fixtures are the ones the checker was built against, copied into the repo
 * so this suite is self-contained (they are under __tests__, which the build
 * skips and the npm `files` whitelist excludes). Each is a real report page:
 * `good.html` agrees with `data.json`; each `broken-*.html` breaks it in exactly
 * one way.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PROJECT_API_TOKEN = 'zby_pat_test';
process.env.ZIBBY_ACCOUNT_API_URL = 'http://cp.local';
process.env.WORKFLOW_TYPE = 'zibby-copilot';

const { artifactSkill, __resetPublishBudget } = await import('../artifact.js');

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'report');
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf-8');
const DATA = JSON.parse(fixture('data.json'));

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const URL_ = `http://box/a/${ID}`;

/**
 * A fetch that SUCCEEDS at everything — publish, read-back, index. Used for the
 * broken fixtures precisely so that a POST, if one happened, would succeed and
 * the test would fail on the call count rather than on a mock error. The mock
 * must not be the thing stopping the request.
 */
function permissiveFetch() {
  return vi.fn(async (url: any, opts: any) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    const json = String(url).includes('/credits/artifacts/')
      ? { metadata: { id: ID }, content: body?.html ?? '', format: 'html' }
      : String(url).includes('/credits/review-memory')
        ? { stored: true }
        : { id: ID, url: URL_, createdAt: '2026-08-14T00:00:00Z' };
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
  });
}

/** Read-back must echo the exact source we sent, or a mismatch pollutes the result. */
function echoingFetch() {
  let sent = '';
  return vi.fn(async (url: any, opts: any) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (u.endsWith('/credits/artifacts')) sent = body?.html ?? body?.markdown ?? '';
    const json = u.includes('/credits/artifacts/')
      ? { metadata: { id: ID }, content: sent, format: 'html' }
      : u.includes('/credits/review-memory')
        ? { stored: true }
        : { id: ID, url: URL_, createdAt: '2026-08-14T00:00:00Z' };
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
  });
}

beforeEach(() => { __resetPublishBudget(); });
afterEach(() => { vi.restoreAllMocks(); });

// ── the happy path ───────────────────────────────────────────────────────────

describe('pre-flight: a page that agrees with its data', () => {
  it('good.html publishes normally — the result is unchanged { id, url }', async () => {
    const f = echoingFetch();
    global.fetch = f as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'Incidents by area', html: fixture('good.html'), data: DATA,
    }));
    expect(out).toEqual({ id: ID, url: URL_ });
    // The POST happened, i.e. the pre-flight let it through.
    expect(f.mock.calls.some((c) => String(c[0]).endsWith('/credits/artifacts'))).toBe(true);
  });

  it('good-echarts.html (SSR chart, bars bound by ecmeta_data_index) also publishes', async () => {
    const f = echoingFetch();
    global.fetch = f as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'Incidents by area', html: fixture('good-echarts.html'), data: DATA,
    }));
    expect(out.url).toBe(URL_);
    expect(out.preflight).toBeUndefined(); // clean AND the probe measured something
  });
});

// ── the whole point: refused BEFORE the wire ─────────────────────────────────

describe('pre-flight: a broken page is refused with NO request made', () => {
  const CASES: Array<[string, string, RegExp]> = [
    // A % width on a display:inline box — CSS throws the width away entirely.
    ['broken-bar-collapsed.html', 'zero-width-bar', /effective display is `inline`/],
    // The largest datum drawn short: the bar is not proportional to its value.
    ['broken-bar-proportion.html', 'bar-proportion', /is drawn at .*but every other bar/],
    // Same defect on the ECharts path, measured off the <path d="…"> geometry.
    ['broken-echarts-bar.html', 'bar-proportion', /is drawn at .*but every other bar/],
    // The data has 20 records; the page renders 17 and silently drops 3.
    ['broken-missing-rows.html', 'data-row-missing', /appear NOWHERE on the page/],
    // `${pct}` and [object Object] reached the reader as visible text.
    ['broken-placeholders.html', 'placeholder-text', /\$\{pct\}|\[object Object\]/],
  ];

  for (const [file, code, messageRe] of CASES) {
    it(`${file} → refused locally, fetch never called, message names [${code}]`, async () => {
      const f = permissiveFetch();
      global.fetch = f as any;

      const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
        title: 'Incidents by area', html: fixture(file), data: DATA,
      }));

      // ── THE assertion: nothing left the process. Not "the POST failed" — the
      // POST was never attempted, so no partial artifact, no wasted round trip.
      expect(f).not.toHaveBeenCalled();

      expect(out.published).toBe(false);
      expect(out.stop).toBe(false);
      expect(out.attemptsRemaining).toBe(1);
      expect(out.defects.some((d: any) => d.code === code)).toBe(true);
      expect(out.error).toMatch(messageRe);
      // It must be unmistakable that no page exists to go looking for.
      expect(out.error).toMatch(/NOTHING was sent/);
      // No url anywhere in the payload — the model must not report a link.
      expect(JSON.stringify(out)).not.toContain(URL_);
    });
  }

  it('names the defect LINE, like the server gate does', async () => {
    global.fetch = permissiveFetch() as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: fixture('broken-placeholders.html'), data: DATA,
    }));
    expect(out.error).toMatch(/^\d+\. \[placeholder-text\] line \d+:/m);
    expect(out.defects[0].line).toBeGreaterThan(0);
  });
});

// ── budget interaction: ONE budget, shared with the 422 path ─────────────────

describe('pre-flight folds into the ONE retry budget', () => {
  it('a local rejection then a FIXED re-send publishes (the repair path works end to end)', async () => {
    const f = echoingFetch();
    global.fetch = f as any;

    const bad = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'Incidents', html: fixture('broken-missing-rows.html'), data: DATA,
    }));
    expect(bad.stop).toBe(false);
    expect(f).not.toHaveBeenCalled();

    const good = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'Incidents', html: fixture('good.html'), data: DATA,
    }));
    expect(good.url).toBe(URL_);
    expect(f.mock.calls.some((c) => String(c[0]).endsWith('/credits/artifacts'))).toBe(true);
  });

  it('TWO consecutive local rejections hit stop-and-be-honest, still with no request', async () => {
    const f = permissiveFetch();
    global.fetch = f as any;

    const first = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: fixture('broken-bar-proportion.html'), data: DATA,
    }));
    expect(first.stop).toBe(false);

    const second = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: fixture('broken-bar-collapsed.html'), data: DATA,
    }));
    expect(second.stop).toBe(true);
    expect(second.attemptsUsed).toBe(2);
    expect(second.instruction).toMatch(/Do NOT call artifact_publish or artifact_update again/);
    expect(f).not.toHaveBeenCalled();
  });

  // The two rejection SOURCES must be indistinguishable to the model — that is
  // what "one decider" means in practice. If a local refusal consumed a separate
  // budget, this sequence would grant a third repair round.
  it('a local rejection and a server 422 share the SAME two attempts', async () => {
    // 1st: refused locally (no request).
    const f1 = permissiveFetch();
    global.fetch = f1 as any;
    const first = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: fixture('broken-bar-collapsed.html'), data: DATA,
    }));
    expect(first.attemptsRemaining).toBe(1);
    expect(f1).not.toHaveBeenCalled();

    // 2nd: passes the pre-flight, the SERVER rejects it → budget is now spent.
    global.fetch = vi.fn(async () => ({
      ok: false, status: 422,
      json: async () => ({ error: 'server says no', defects: [{ code: 'markdown-in-html', line: 3, message: 'x' }] }),
      text: async () => JSON.stringify({ error: 'server says no', defects: [{ code: 'markdown-in-html', line: 3, message: 'x' }] }),
    })) as any;
    const second = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: fixture('good.html'), data: DATA,
    }));
    expect(second.stop).toBe(true);
    expect(second.attemptsUsed).toBe(2);
  });

  it('a local rejection produces the SAME envelope shape as a server 422', async () => {
    global.fetch = permissiveFetch() as any;
    const local = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: fixture('broken-bar-collapsed.html'), data: DATA,
    }));

    __resetPublishBudget();
    global.fetch = vi.fn(async () => ({
      ok: false, status: 422,
      json: async () => ({ error: 'server says no', defects: [] }),
      text: async () => JSON.stringify({ error: 'server says no', defects: [] }),
    })) as any;
    const server = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: '<p>x</p>',
    }));

    expect(Object.keys(local).sort()).toEqual(Object.keys(server).sort());
    expect(local.instruction).toBe(server.instruction); // same builder, same advice
  });

  it('a SUCCESS resets the budget after a local rejection, like any other', async () => {
    global.fetch = echoingFetch() as any;
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: fixture('broken-missing-rows.html'), data: DATA });
    const ok = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T2', markdown: '# fine' }));
    expect(ok.url).toBe(URL_);
    // Back to a full budget: one rejection must not stop us.
    const later = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T3', html: fixture('broken-missing-rows.html'), data: DATA }));
    expect(later.stop).toBe(false);
    expect(later.attemptsRemaining).toBe(1);
  });

  it('an exhausted budget short-circuits a data publish too — no check, no request', async () => {
    const f = permissiveFetch();
    global.fetch = f as any;
    for (let i = 0; i < 3; i += 1) {
      await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: fixture('broken-bar-collapsed.html'), data: DATA });
    }
    expect(f).not.toHaveBeenCalled();
  });
});

// ── additive by construction: no `data` ⇒ byte-identical behaviour ───────────

describe('omitting `data` is byte-identical to before the argument existed', () => {
  it('a broken-by-data page with NO data passed publishes exactly as it always did', async () => {
    const f = echoingFetch();
    global.fetch = f as any;
    // The SAME fixture that is refused above. Without `data` there is nothing to
    // check against, so the call must behave as it did before this feature: POST,
    // read back, index, return { id, url } and nothing else.
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'Incidents', html: fixture('broken-missing-rows.html'),
    }));
    expect(out).toEqual({ id: ID, url: URL_ });
    const write = f.mock.calls.find((c) => String(c[0]).endsWith('/credits/artifacts'));
    expect(write).toBeTruthy();
    expect(JSON.parse((write as any)[1].body).html).toBe(fixture('broken-missing-rows.html'));
  });

  it('`data: null` / `data: undefined` are treated as absent, not as an error', async () => {
    global.fetch = echoingFetch() as any;
    for (const data of [null, undefined]) {
      __resetPublishBudget();
      const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
        title: 'T', html: fixture('broken-missing-rows.html'), data,
      }));
      expect(out).toEqual({ id: ID, url: URL_ });
    }
  });

  it('the markdown path is untouched', async () => {
    const f = echoingFetch();
    global.fetch = f as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', markdown: '# hi' }));
    expect(out).toEqual({ id: ID, url: URL_ });
  });

  // The case above still has a table, so a check running UNCONDITIONALLY would
  // measure something and stay silent — the test would pass either way. This one
  // is a page the probe provably cannot measure: if the check ran without `data`
  // it would attach `preflight: unverified` and this fails.
  it('a page the probe could not measure carries NO preflight field when no data is passed', async () => {
    global.fetch = echoingFetch() as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'Prose', html: '<!doctype html><html><body><h1>Summary</h1><p>All quiet.</p></body></html>',
    }));
    expect(out).toEqual({ id: ID, url: URL_ });
  });
});

// ── `data` where it cannot work is an ERROR, never a silent no-op ────────────

describe('`data` without html', () => {
  it('markdown + data is refused, with no request and NO budget consumed', async () => {
    const f = permissiveFetch();
    global.fetch = f as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', markdown: '# Incidents\n\n| a | b |\n|---|---|\n| 1 | 2 |', data: DATA,
    }));
    expect(out.error).toMatch(/only meaningful together with `html`/);
    expect(f).not.toHaveBeenCalled();
    // A malformed CALL is not a broken PAGE: the repair budget is untouched.
    expect(out.stop).toBeUndefined();
    expect(out.attemptsRemaining).toBeUndefined();
    const still = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: fixture('broken-bar-collapsed.html'), data: DATA,
    }));
    expect(still.attemptsRemaining).toBe(1); // i.e. this was the FIRST rejection
  });

  // The error must not push the model off the markdown default to buy a check —
  // that would use a diagnostic to defeat the template freeze.
  it('the error does NOT advise switching to html', async () => {
    global.fetch = permissiveFetch() as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', markdown: '# x', data: DATA,
    }));
    expect(out.error).toMatch(/Do NOT switch to `html`/);
  });

  it('a title-only artifact_update with data is refused for the same reason', async () => {
    const f = permissiveFetch();
    global.fetch = f as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_update', { id: ID, title: 'New', data: DATA }));
    expect(out.error).toMatch(/only meaningful together with `html`/);
    expect(f).not.toHaveBeenCalled();
  });

  it('data as a JSON STRING is accepted (the model may stringify it)', async () => {
    const f = permissiveFetch();
    global.fetch = f as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: fixture('broken-missing-rows.html'), data: JSON.stringify(DATA),
    }));
    expect(out.published).toBe(false); // it really was parsed and checked
    expect(f).not.toHaveBeenCalled();
  });

  it('data as an UNPARSEABLE string is a clear error, not a silent skip', async () => {
    const f = permissiveFetch();
    global.fetch = f as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: fixture('good.html'), data: '{not json',
    }));
    expect(out.error).toMatch(/not valid JSON/);
    expect(f).not.toHaveBeenCalled();
  });
});

// ── fail-open: the probe never blocks, and never bluffs ──────────────────────

describe('the pre-flight fails open and reports a probe that measured nothing', () => {
  it('a page with no tables and no bars publishes, flagged `unverified`', async () => {
    global.fetch = echoingFetch() as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'Prose', html: '<!doctype html><html><body><h1>Summary</h1><p>All quiet.</p></body></html>', data: DATA,
    }));
    // Published — a probe that cannot measure must never withhold a url.
    expect(out.url).toBe(URL_);
    expect(out.preflight.status).toBe('unverified');
    expect(out.preflight.reason).toMatch(/no tables and no bars/);
    // The receipt is attached so the claim is auditable, per the probe rule.
    expect(out.preflight.checked).toBeTruthy();
  });

  it('artifact_update carries the same pre-flight', async () => {
    const f = permissiveFetch();
    global.fetch = f as any;
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_update', {
      id: ID, html: fixture('broken-bar-collapsed.html'), data: DATA,
    }));
    expect(out.published).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

// ── the contract the model reads ─────────────────────────────────────────────
// A capability the model is never told about is the gap `artifact_get` had for
// months. The description must say WHEN to pass it, concretely.
describe('the tool contract advertises `data`', () => {
  const publish = () => artifactSkill.tools.find((t: any) => t.name === 'artifact_publish');

  it('declares the argument on both write tools', () => {
    expect(publish().input_schema.properties.data).toBeTruthy();
    expect(artifactSkill.tools.find((t: any) => t.name === 'artifact_update').input_schema.properties.data).toBeTruthy();
    expect(publish().input_schema.required).not.toContain('data'); // additive
  });

  it('the description names the concrete trigger (a page that renders a dataset)', () => {
    const d = publish().description;
    expect(d).toMatch(/PASS `data` WHENEVER THE HTML PAGE RENDERS A DATASET/);
    expect(d).toMatch(/table of records, a bar chart/);
    expect(d).toMatch(/never pass it with `markdown`/);
  });

  it('the description says both rejection kinds share ONE budget', () => {
    expect(publish().description).toMatch(/SAME two attempts/);
  });

  it('the prompt fragment tells the model to pass the data unchanged', () => {
    expect(artifactSkill.promptFragment).toMatch(/unchanged and unsummarised/);
    expect(artifactSkill.promptFragment).toMatch(/Do not write\s+your own expectations/);
  });
});
