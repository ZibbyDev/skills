/**
 * artifactSkill tests — the tool dispatch + the two-layer split:
 *   - CONTENT goes to the control-plane blob write (POST /artifacts).
 *   - INDEX goes to kv-memory (POST /credits/review-memory, op 'store') under the
 *     SAME auto-namespaced scope kv-memory reads (`<WORKFLOW_TYPE>:artifact:<id>`)
 *     so a later kv_recall_prefix('artifact:') lists exactly what was published.
 * No real network — global.fetch is mocked and we assert on the requests made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.PROJECT_API_TOKEN = 'zby_pat_test';
process.env.ZIBBY_ACCOUNT_API_URL = 'http://cp.local';
process.env.WORKFLOW_TYPE = 'zibby-copilot';

const { artifactSkill, __resetPublishBudget, __compareStoredSource } = await import('../artifact.js');

// Route the mocked fetch by URL + parse the JSON body for assertions.
function mockFetch(routes) {
  return vi.fn(async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    for (const [match, resp] of routes) {
      if (url.includes(match)) {
        const r = typeof resp === 'function' ? resp(body, url) : resp;
        return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json, text: async () => JSON.stringify(r.json) };
      }
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

let calls;
beforeEach(() => { calls = []; __resetPublishBudget(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('artifact_publish', () => {
  it('writes the blob then indexes it in kv-memory under the auto-namespaced scope', async () => {
    global.fetch = mockFetch([
      // The post-publish read-back (GET .../artifacts/<id>) serves the content
      // back UNCHANGED, so this stays a clean-path test: the result must be
      // exactly { id, url } with no readBack noise.
      ['/credits/artifacts/', () => ({ json: { metadata: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, content: '<h1>hi</h1>', format: 'html' } })],
      ['/artifacts', (body, url) => { calls.push(['write', url, body]); return { json: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'http://box/a/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', createdAt: '2026-07-17T00:00:00Z' } }; }],
      ['/credits/review-memory', (body, url) => { calls.push(['index', url, body]); return { json: { stored: true } }; }],
    ]);

    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'Status Report', html: '<h1>hi</h1>', kind: 'report', summary: 'weekly status',
    }));
    expect(out).toEqual({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'http://box/a/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });

    // 1) blob write carried the content + title, NOT account/project.
    const write = calls.find((c) => c[0] === 'write');
    expect(write[1]).toBe('http://cp.local/credits/artifacts');
    expect(write[2]).toMatchObject({ title: 'Status Report', html: '<h1>hi</h1>', kind: 'report' });

    // 2) index write hit kv-memory at scope `<WORKFLOW_TYPE>:artifact:<id>`.
    const index = calls.find((c) => c[0] === 'index');
    expect(index[1]).toBe('http://cp.local/credits/review-memory');
    expect(index[2].op).toBe('store');
    expect(index[2].scope).toBe('zibby-copilot:artifact:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const rec = JSON.parse(index[2].content);
    expect(rec).toMatchObject({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Status Report', kind: 'report', summary: 'weekly status' });
  });

  it('rejects missing title or neither content form', async () => {
    global.fetch = mockFetch([]);
    expect(JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { html: '<p>x</p>' })).error).toMatch(/title/);
    expect(JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T' })).error).toMatch(/markdown \(preferred\) or html/);
  });

  // The two fields are DIFFERENT rendering paths, so silently picking one is how
  // you ship the wrong format. Previously html won without a word.
  it('refuses BOTH markdown and html rather than silently choosing', async () => {
    global.fetch = mockFetch([]);
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', markdown: '# a', html: '<h1>a</h1>' }));
    expect(out.error).toMatch(/EITHER markdown OR html, not both/);
  });

  it('sends markdown as `markdown` (the default path — our renderer owns the skeleton)', async () => {
    global.fetch = mockFetch([
      ['/credits/artifacts', (body, url) => { calls.push(['write', url, body]); return { json: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'http://box/artifact/x' } }; }],
      ['/credits/review-memory', () => ({ json: { stored: true } })],
    ]);
    await artifactSkill.handleToolCall('artifact_publish', { title: 'Q3', markdown: '# Q3\n\n| A | B |\n|---|---|\n| 1 | 2 |' });
    const write = calls.find((c) => c[0] === 'write');
    expect(write[2].markdown).toContain('| A | B |');
    expect(write[2].html).toBeUndefined();
  });
});

// ── the retry budget (the ONLY thing this skill owns besides the contract) ────
// The RULES live in backend/src/utils/artifact-validate.js — this skill
// implements none of them. What it owns is turn-local state the stateless
// handler cannot hold: after MAX_PUBLISH_ATTEMPTS rejections, stop and be honest.
describe('artifact_publish share:true — publish and open the door in one call', () => {
  const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const routes = (writeJson) => [
    ['/credits/artifacts/', () => ({ json: { metadata: { id: ID }, content: '<h1>hi</h1>', format: 'html' } })],
    ['/artifacts', (body, url) => { calls.push(['write', url, body]); return { json: writeJson }; }],
    ['/credits/review-memory', () => ({ json: { stored: true } })],
  ];

  it('forwards share and relays the url + password the write issued', async () => {
    // Before this, a page meant for a chat channel was published WITHOUT a door
    // and needed a second call to get a link its readers could open.
    global.fetch = mockFetch(routes({
      id: ID, url: `http://box/a/${ID}`, createdAt: '2026-07-17T00:00:00Z',
      shared: true, shareUrl: `http://box/artifacts/${ID}/view`, password: 'zx8Q-generated-9fk2',
    }));

    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: '<h1>hi</h1>', share: true,
    }));

    expect(calls.find((c) => c[0] === 'write')[2].share).toBe(true);
    expect(out.shared).toBe(true);
    expect(out.shareUrl).toBe(`http://box/artifacts/${ID}/view`);
    // The password is in that response ONCE and is never readable again, so a
    // handler that drops it makes share:true accomplish nothing.
    expect(out.password).toBe('zx8Q-generated-9fk2');
    expect(out.instruction).toMatch(/BOTH/);
  });

  it('the password is NEVER written into the kv-memory index', async () => {
    // Security invariant #4: a secret may not be persisted into memory. The
    // index record is built from an explicit field list, which is the only
    // reason the password does not ride along — nothing enforced it, and a
    // later `{...out}` spread would leak it into every kv_recall_prefix
    // result forever. It is a page-viewing password, not a credential, but
    // "shown exactly once" is the contract the tool description makes and an
    // index entry silently breaks it.
    const indexed: any[] = [];
    global.fetch = mockFetch([
      ['/credits/artifacts/', () => ({ json: { metadata: { id: ID }, content: '<h1>hi</h1>', format: 'html' } })],
      ['/artifacts', () => ({ json: {
        id: ID, url: `http://box/a/${ID}`, createdAt: '2026-07-17T00:00:00Z',
        shared: true, shareUrl: `http://box/artifacts/${ID}/view`, password: 'zx8Q-generated-9fk2',
      } })],
      ['/credits/review-memory', (body) => { indexed.push(body); return { json: { stored: true } }; }],
    ]);

    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: '<h1>hi</h1>', share: true,
    }));
    expect(out.password).toBe('zx8Q-generated-9fk2'); // it DID issue one…

    const written = JSON.stringify(indexed);
    expect(written).not.toContain('zx8Q-generated-9fk2'); // …and none of it was stored
    expect(written).not.toContain('password');
    expect(JSON.parse(indexed[0].content)).toEqual({
      id: ID, title: 'T', url: `http://box/a/${ID}`, kind: null,
      createdAt: '2026-07-17T00:00:00Z', summary: 'T',
    });
  });

  it('never sends a caller-chosen password, even when one is passed', async () => {
    // A deliberate limit, not an oversight: a model asked to invent a password
    // invents a guessable one. `artifact_share` refuses the parameter for the
    // same reason, and publish must not become the way around it.
    global.fetch = mockFetch(routes({ id: ID, url: `http://box/a/${ID}`, createdAt: '2026-07-17T00:00:00Z' }));
    await artifactSkill.handleToolCall('artifact_publish', {
      title: 'T', html: '<h1>hi</h1>', share: true, password: 'hunter2hunter2',
    });
    expect(calls.find((c) => c[0] === 'write')[2].password).toBeUndefined();
  });

  it('WITHOUT share the request is byte-identical to before — no password anywhere', async () => {
    global.fetch = mockFetch(routes({ id: ID, url: `http://box/a/${ID}`, createdAt: '2026-07-17T00:00:00Z' }));
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<h1>hi</h1>' }));
    const write = calls.find((c) => c[0] === 'write')[2];
    expect(write.share).toBeUndefined();
    expect(write.password).toBeUndefined();
    expect(out).toEqual({ id: ID, url: `http://box/a/${ID}` });
  });

  it('share:false is not forwarded either — only an explicit true opens a door', async () => {
    global.fetch = mockFetch(routes({ id: ID, url: `http://box/a/${ID}`, createdAt: '2026-07-17T00:00:00Z' }));
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<h1>hi</h1>', share: false });
    expect(calls.find((c) => c[0] === 'write')[2].share).toBeUndefined();
  });
});

describe('publish retry budget', () => {
  const DEFECTS = [{ code: 'zero-width-bar', line: 12, message: '<span class="bar"> has no width.' }];
  function rejectingFetch(times) {
    let n = 0;
    return mockFetch([
      ['/credits/artifacts', () => {
        n += 1;
        if (n <= times) return { ok: false, status: 422, json: { error: 'Artifact NOT published — the page has 1 defect:\n1. [zero-width-bar] line 12: <span class="bar"> has no width.', defects: DEFECTS } };
        return { json: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'http://box/artifact/x' } };
      }],
      ['/credits/review-memory', () => ({ json: { stored: true } })],
    ]);
  }

  it('1st rejection: relays the exact defects and grants ONE more attempt', async () => {
    global.fetch = rejectingFetch(1);
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<h1>Bars</h1><span class="bar"></span>' }));
    expect(out.published).toBe(false);
    expect(out.stop).toBe(false);
    expect(out.attemptsRemaining).toBe(1);
    expect(out.defects).toEqual(DEFECTS);
    expect(out.error).toMatch(/line 12/);
    // On the html path the advice is to switch to markdown — the evidence-backed
    // fix, since later repair iterations rarely fix what the first got wrong.
    expect(out.instruction).toMatch(/re-send the SAME content as `markdown`/);
  });

  it('2nd rejection: STOPS and tells the model to report the failure honestly', async () => {
    global.fetch = rejectingFetch(2);
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' });
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' }));
    expect(out.stop).toBe(true);
    expect(out.attemptsUsed).toBe(2);
    expect(out.instruction).toMatch(/Do NOT call artifact_publish or artifact_update again/);
    expect(out.instruction).toMatch(/A broken link is worse than an honest/);
    expect(out.url).toBeUndefined();
  });

  it('a 3rd call short-circuits without even reaching the backend', async () => {
    let hits = 0;
    global.fetch = mockFetch([
      ['/credits/artifacts', () => { hits += 1; return { ok: false, status: 422, json: { error: 'broken', defects: DEFECTS } }; }],
    ]);
    for (let i = 0; i < 3; i += 1) await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' });
    expect(hits).toBe(2); // the 3rd never left the process
  });

  it('the budget covers artifact_update too — one shared budget, not two', async () => {
    global.fetch = rejectingFetch(9);
    await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' });
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_update', { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', html: '<span class="bar"></span>' }));
    expect(out.stop).toBe(true);
  });

  it('a SUCCESS resets the budget — a long run publishing several pages is not penalised', async () => {
    global.fetch = rejectingFetch(1); // 1st call 422, everything after succeeds
    const first = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' }));
    expect(first.stop).toBe(false);
    const ok = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T2', markdown: '# fine' }));
    expect(ok.url).toBe('http://box/artifact/x');
    // budget is back to full: a later single rejection must NOT stop us
    global.fetch = rejectingFetch(1);
    const later = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T3', html: '<span class="bar"></span>' }));
    expect(later.stop).toBe(false);
    expect(later.attemptsRemaining).toBe(1);
  });

  it('a NON-422 failure (auth/quota/outage) does NOT consume the budget', async () => {
    global.fetch = mockFetch([['/credits/artifacts', () => ({ ok: false, status: 503, json: { error: 'upstream down' } })]]);
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', markdown: '# a' }));
    expect(out.error).toMatch(/503/);
    expect(out.stop).toBeUndefined();
    // still has both attempts
    global.fetch = rejectingFetch(1);
    const next = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', { title: 'T', html: '<span class="bar"></span>' }));
    expect(next.attemptsRemaining).toBe(1);
  });
});

// ── the contract the model reads ─────────────────────────────────────────────
// The template freeze is delivered ENTIRELY through the declaration (description
// + prompt fragment), not through a per-caller branch. If the wording stops
// saying "prefer markdown", the freeze silently stops happening.
describe('the tool contract makes markdown the default', () => {
  const publish = () => artifactSkill.tools.find((t) => t.name === 'artifact_publish');

  it('tells the model to use markdown and that html is the exception', () => {
    const d = publish().description;
    expect(d).toMatch(/USE `markdown`/);
    expect(d).toMatch(/Use `html` ONLY when/);
  });

  it('states what markdown CAN express — including tables', () => {
    const d = publish().description;
    expect(d).toMatch(/GitHub-style pipe tables/);
    expect(d).toMatch(/bullet \+ numbered lists/);
    expect(publish().input_schema.properties.markdown.description).toMatch(/PREFERRED/);
  });

  it('states what markdown CANNOT express, so the html path stays justified', () => {
    const d = publish().description;
    expect(d).toMatch(/does NOT support raw HTML/);
    expect(d).toMatch(/images/);
  });

  it('nudges figures toward tool results rather than prose arithmetic', () => {
    expect(publish().description).toMatch(/do not do arithmetic in prose/i);
  });

  it('warns that content is validated before a URL exists and the retries are capped', () => {
    expect(publish().description).toMatch(/VALIDATED before any URL exists/);
    expect(publish().description).toMatch(/ONE retry/);
  });

  it('the prompt fragment carries the same defaults', () => {
    expect(artifactSkill.promptFragment).toMatch(/WRITE IT AS MARKDOWN/);
    expect(artifactSkill.promptFragment).toMatch(/pipe tables/);
    expect(artifactSkill.promptFragment).toMatch(/must come from a tool result/);
  });
});

describe('artifact_update', () => {
  it('recalls the prior index record to preserve createdAt, then re-stores', async () => {
    const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    global.fetch = mockFetch([
      // clean read-back (see the read-back describe block below)
      ['/credits/artifacts/', () => ({ json: { metadata: { id: ID }, content: '# new', format: 'markdown' } })],
      ['/artifacts', (body, url) => { calls.push(['write', url, body]); return { json: { id: ID, url: `http://box/a/${ID}`, updatedAt: '2026-07-18T00:00:00Z' } }; }],
      ['/credits/review-memory', (body, url) => {
        calls.push([body.op, url, body]);
        if (body.op === 'recall') return { json: { found: true, memory: { content: JSON.stringify({ id: ID, title: 'Old', createdAt: '2026-07-01T00:00:00Z', url: `http://box/a/${ID}` }) } } };
        return { json: { stored: true } };
      }],
    ]);

    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_update', { id: ID, title: 'New', markdown: '# new' }));
    expect(out).toEqual({ id: ID, url: `http://box/a/${ID}` });
    const stored = calls.find((c) => c[0] === 'store');
    const rec = JSON.parse(stored[2].content);
    expect(rec.createdAt).toBe('2026-07-01T00:00:00Z'); // preserved
    expect(rec.title).toBe('New');
    expect(rec.updatedAt).toBe('2026-07-18T00:00:00Z');
  });

  it('requires an id', async () => {
    global.fetch = mockFetch([]);
    expect(JSON.parse(await artifactSkill.handleToolCall('artifact_update', { title: 'x' })).error).toMatch(/id is required/);
  });
});

describe('artifact_get', () => {
  it('fetches metadata + content by id', async () => {
    const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    global.fetch = mockFetch([
      [`/artifacts/${ID}`, () => ({ json: { metadata: { id: ID, title: 'G' }, content: '# hi', format: 'markdown' } })],
    ]);
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_get', { id: ID }));
    expect(out.metadata.title).toBe('G');
    expect(out.content).toBe('# hi');
  });
});

// ── post-publish read-back ───────────────────────────────────────────────────
// Closes the loop the skill previously left open: after a 2xx publish, GET the
// artifact back and prove the STORED SOURCE is the source we sent.
//
// SCOPE, and the tests hold it to it: this is TRANSPORT/STORAGE integrity only.
// It says nothing about whether the page renders — the stored blob is the source,
// the document is built later. Every verdict carries that sentence.
//
// WHY EXACT EQUALITY DOESN'T CRY WOLF — verified in backend/src/handlers/
// artifacts.js, not assumed: the POST writes `Body: source` (the raw string off
// JSON.parse) with no trim / trailing-newline / BOM / unicode normalisation, the
// validator returns only {ok, defects} and never a rewritten source, and the GET
// is transformToString() (utf-8). The corpus test below is the guard on that.
describe('post-publish read-back', () => {
  const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const URL = `http://box/artifact/${ID}`;

  /**
   * A backend that ACCEPTS the publish and then serves `stored` on the read-back
   * GET — the point being that `stored` may differ from what was sent.
   *   stored instanceof Error → the GET throws (network failure)
   *   stored === undefined    → the GET response has no `content` field
   *   opts.getStatus          → the GET returns that non-2xx status
   * Returns the array of requests made, so a test can assert the GET happened
   * (or didn't) and against which URL.
   */
  function backend(stored, opts: any = {}) {
    const seen: any[] = [];
    global.fetch = vi.fn(async (url: any, init: any) => {
      const method = init?.method || 'GET';
      seen.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).includes('/credits/review-memory')) {
        if (opts.indexFails) return { ok: false, status: 500, text: async () => 'kv down' } as any;
        const op = JSON.parse(init.body).op;
        return { ok: true, status: 200, json: async () => (op === 'recall' ? { found: false } : { stored: true }) } as any;
      }
      if (String(url).includes('/credits/artifacts')) {
        if (method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ id: ID, url: URL, createdAt: '2026-08-14T00:00:00Z', updatedAt: '2026-08-14T00:00:00Z' }) } as any;
        }
        if (stored instanceof Error) throw stored;
        if (opts.getStatus) return { ok: false, status: opts.getStatus, text: async () => 'not found' } as any;
        const payload: any = { metadata: { id: ID, title: 'T' }, format: 'markdown' };
        if (stored !== undefined) payload.content = stored;
        return { ok: true, status: 200, json: async () => payload } as any;
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as any;
    return seen;
  }

  const publish = (markdown) => artifactSkill.handleToolCall('artifact_publish', { title: 'T', markdown });

  it('identical content → clean, and the tool result is EXACTLY { id, url }', async () => {
    const seen = backend('# Report\n\n| A | B |\n|---|---|\n| 1 | 2 |\n');
    const out = JSON.parse(await publish('# Report\n\n| A | B |\n|---|---|\n| 1 | 2 |\n'));
    expect(out).toEqual({ id: ID, url: URL }); // no readBack noise on the happy path
    // and it really did go and look — at the right, member-gated backend route.
    const get = seen.find((r) => r.method === 'GET');
    expect(get.url).toBe(`http://cp.local/credits/artifacts/${ID}`);
  });

  // The anti-cry-wolf test. Each of these is something a naive checker would
  // "helpfully" normalise away (or a careless backend might); the round trip
  // preserves all of them verbatim, so NONE may be reported.
  it('content the backend stores verbatim is NEVER flagged (trailing newline, CRLF, BOM, NFD, astral emoji)', async () => {
    const corpus = [
      '# ends with a newline\n',
      '# no trailing newline',
      '# crlf\r\n\r\nline two\r\n',
      '﻿# leading BOM',
      '# NFD: é vs NFC: é',
      '# astral 🧪🚀 and CJK 中文测试',
      '# tabs\t and  double  spaces   ',
      '<h1>html &amp; entities &lt;kept&gt;</h1>',
      '# control chars \u0000 \u001b[31m \u000b survive JSON + utf-8 both ways',
      // A well-formed surrogate PAIR must round-trip; a LONE surrogate is the one
      // input utf-8 cannot carry, so the comparator deliberately does not
      // special-case it — if a backend ever replaces one with U+FFFD, fire.
      '# paired astral \u{1F9EA} stays paired',
    ];
    for (const c of corpus) {
      __resetPublishBudget();
      backend(c);
      const out = JSON.parse(await publish(c));
      expect(out, `flagged verbatim content: ${JSON.stringify(c)}`).toEqual({ id: ID, url: URL });
    }
  });

  it('truncated content → mismatch that NAMES the delta, the offset and both excerpts', async () => {
    const sent = '# Quarterly Report\n\nAll thirty findings follow.\n' + 'x'.repeat(200);
    backend(sent.slice(0, 60));
    const out = JSON.parse(await publish(sent));

    expect(out.id).toBe(ID);
    expect(out.url).toBe(URL); // the page exists — a mismatch is NOT a failed publish
    expect(out.error).toBeUndefined();
    expect(out.readBack.status).toBe('mismatch');
    expect(out.readBack.kind).toBe('truncated');
    expect(out.readBack.sentChars).toBe(sent.length);
    expect(out.readBack.storedChars).toBe(60);
    expect(out.readBack.delta).toBe(60 - sent.length);
    expect(out.readBack.firstDiffAt).toBe(60);
    expect(out.readBack.sentExcerpt).toEqual(expect.any(String));
    expect(out.readBack.storedExcerpt).toEqual(expect.any(String));
    // the honest-scope sentence travels with every verdict
    expect(out.readBack.scope).toMatch(/does NOT check that the page renders/);
    // and the advice is bounded — rewrite once, then tell the user; never loop
    expect(out.readBack.note).toMatch(/artifact_update ONCE/);
    expect(out.readBack.note).toMatch(/do NOT re-publish/i);
  });

  it('content that differs mid-stream → diverged, with the first differing offset', async () => {
    backend('# Report\n\nTOTAL: 45 findings');
    const out = JSON.parse(await publish('# Report\n\nTOTAL: 42 findings'));
    expect(out.readBack.status).toBe('mismatch');
    expect(out.readBack.kind).toBe('diverged');
    expect(out.readBack.firstDiffAt).toBe('# Report\n\nTOTAL: 4'.length);
    expect(out.readBack.delta).toBe(0);
    expect(out.readBack.storedExcerpt).toContain('45');
    expect(out.readBack.sentExcerpt).toContain('42');
  });

  it('extra content appended → longer', async () => {
    backend('# a\ninjected');
    const out = JSON.parse(await publish('# a\n'));
    expect(out.readBack.kind).toBe('longer');
    expect(out.readBack.delta).toBe(8);
  });

  // FAIL-SOFT. The blob write already returned 2xx, so the URL exists and is
  // valid; a broken probe must never be reported as a broken publish.
  it('read-back THROWS (network) → publish still reported successful, verdict is unverified', async () => {
    backend(new Error('ECONNRESET'));
    const out = JSON.parse(await publish('# a'));
    expect(out.id).toBe(ID);
    expect(out.url).toBe(URL);
    expect(out.error).toBeUndefined();
    expect(out.readBack.status).toBe('unverified');
    expect(out.readBack.status).not.toBe('mismatch');
    expect(out.readBack.reason).toMatch(/ECONNRESET/);
    expect(out.readBack.note).toMatch(/No action needed/);
  });

  it('read-back 404 (propagation delay) → unverified, never mismatch', async () => {
    backend('# a', { getStatus: 404 });
    const out = JSON.parse(await publish('# a'));
    expect(out.url).toBe(URL);
    expect(out.readBack.status).toBe('unverified');
    expect(out.readBack.reason).toMatch(/404/);
  });

  it('read-back with no content field → unverified', async () => {
    backend(undefined);
    const out = JSON.parse(await publish('# a'));
    expect(out.url).toBe(URL);
    expect(out.readBack.status).toBe('unverified');
    expect(out.readBack.reason).toMatch(/no content field/);
  });

  // The backend's GET swallows an object-store read error into `content: ''`, so
  // an empty read-back cannot be told apart from a transient read failure — and
  // it cannot mean the write was lost (the PutObject is awaited; a failure there
  // would have produced a non-2xx with no id/url). Calling it a mismatch would be
  // crying wolf at our own probe.
  it('empty content read-back is INCONCLUSIVE, not a mismatch', async () => {
    backend('');
    const out = JSON.parse(await publish('# a real page'));
    expect(out.readBack.status).toBe('unverified');
    expect(out.readBack.reason).toMatch(/empty content/);
    expect(out.readBack.reason).toMatch(/indistinguishable/);
  });

  it('a mismatch and an index failure coexist — neither hides the other', async () => {
    backend('truncated', { indexFails: true });
    const out = JSON.parse(await publish('the full page content'));
    expect(out.url).toBe(URL);
    expect(out.readBack.status).toBe('mismatch');
    expect(out.indexWarning).toMatch(/artifact index write failed/);
  });

  it('artifact_update read-backs when it sent content', async () => {
    const seen = backend('# stale previous version');
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_update', { id: ID, markdown: '# the new version' }));
    expect(out.url).toBe(URL);
    expect(out.readBack.status).toBe('mismatch');
    expect(seen.some((r) => r.method === 'GET' && r.url.endsWith(`/artifacts/${ID}`))).toBe(true);
  });

  // A title-only update rewrites no blob, so the stored source is the PREVIOUS
  // one — comparing would be a guaranteed false positive.
  it('artifact_update with only a title does NOT read back at all', async () => {
    const seen = backend('# whatever is already stored');
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_update', { id: ID, title: 'Renamed' }));
    expect(out).toEqual({ id: ID, url: URL });
    expect(seen.some((r) => r.method === 'GET' && r.url.includes('/credits/artifacts/'))).toBe(false);
  });

  it('a REJECTED publish never read-backs (there is no artifact to read)', async () => {
    let gets = 0;
    global.fetch = vi.fn(async (url: any, init: any) => {
      const method = init?.method || 'GET';
      if (String(url).includes('/credits/artifacts')) {
        if (method === 'GET') { gets += 1; return { ok: true, status: 200, json: async () => ({ content: '' }) } as any; }
        return { ok: false, status: 422, text: async () => JSON.stringify({ error: 'broken', defects: [] }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({ stored: true }) } as any;
    }) as any;
    await publish('# broken');
    expect(gets).toBe(0);
  });
});

describe('__compareStoredSource (the comparator, directly)', () => {
  it('identical → null', () => {
    expect(__compareStoredSource('abc', 'abc')).toBeNull();
    expect(__compareStoredSource('', '')).toBeNull();
  });
  it('prefix relationships are classified, not just "different"', () => {
    expect(__compareStoredSource('abcdef', 'abc')).toMatchObject({ kind: 'truncated', firstDiffAt: 3, delta: -3 });
    expect(__compareStoredSource('abc', 'abcdef')).toMatchObject({ kind: 'longer', firstDiffAt: 3, delta: 3 });
    expect(__compareStoredSource('abcdef', 'abcXef')).toMatchObject({ kind: 'diverged', firstDiffAt: 3, delta: 0 });
  });
  it('excerpts are bounded and escape newlines so the message stays one readable line', () => {
    const d: any = __compareStoredSource('a\n'.repeat(500), 'a\n'.repeat(500) + 'tail');
    expect(d.sentExcerpt).not.toContain('\n');
    expect(d.sentExcerpt.length).toBeLessThan(200);
  });
});

describe('skill shape', () => {
  it('exposes exactly the five artifact tools (list is delegated to kv-memory)', () => {
    expect(artifactSkill.id).toBe('artifact');
    expect(artifactSkill.tools.map((t) => t.name).sort()).toEqual([
      'artifact_get', 'artifact_publish', 'artifact_share', 'artifact_unshare', 'artifact_update',
    ]);
    expect(artifactSkill.allowedTools).toContain('mcp__artifact__*');
  });

  it('artifact_share takes NO password parameter', () => {
    // Deliberate: the backend accepts a caller-chosen password, but a model asked
    // to invent one invents a guessable one. The tool the MODEL can reach only
    // ever gets the server-generated default; a human picks their own via
    // `zibby artifact share --password`. If this ever fails, that decision was
    // undone by accident.
    const share = artifactSkill.tools.find((t) => t.name === 'artifact_share');
    expect(Object.keys(share.input_schema.properties)).toEqual(['id']);
  });
});

describe('artifact_publish rn passthrough', () => {
  // The OUTPUT half of the reference story: the backend mints `rn` on the write
  // response (backend 30f3e620); the skill must hand it to the model, or the
  // model's only way to learn a just-published artifact's rn is artifact_get —
  // which drags the whole document back into context, the exact waste
  // references exist to kill.
  const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const RN = `rn:box:acct-1:proj-1:artifact:${ID}`;

  it('a backend response carrying rn reaches the model verbatim', async () => {
    global.fetch = mockFetch([
      ['/credits/artifacts/', () => ({ json: { metadata: { id: ID }, content: '<h1>hi</h1>', format: 'html' } })],
      ['/artifacts', () => ({ json: { id: ID, url: `http://box/a/${ID}`, rn: RN, createdAt: '2026-07-17T00:00:00Z' } })],
      ['/credits/review-memory', () => ({ json: { stored: true } })],
    ]);
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'Report', html: '<h1>hi</h1>',
    }));
    expect(out.rn).toBe(RN);
  });

  it('a pre-30f3e620 backend (no rn in the response) still yields exactly { id, url } — no undefined key, no error', async () => {
    global.fetch = mockFetch([
      ['/credits/artifacts/', () => ({ json: { metadata: { id: ID }, content: '<h1>hi</h1>', format: 'html' } })],
      ['/artifacts', () => ({ json: { id: ID, url: `http://box/a/${ID}`, createdAt: '2026-07-17T00:00:00Z' } })],
      ['/credits/review-memory', () => ({ json: { stored: true } })],
    ]);
    const out = JSON.parse(await artifactSkill.handleToolCall('artifact_publish', {
      title: 'Report', html: '<h1>hi</h1>',
    }));
    expect(out).toEqual({ id: ID, url: `http://box/a/${ID}` });
    expect('rn' in out).toBe(false);
  });
});
