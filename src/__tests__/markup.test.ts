/**
 * `lib/markup.ts` — the ONE grammar every board body is written and read with.
 *
 * Three properties the fleet's own parsers stand on (see the module header),
 * each one a test here: a line is a block; block syntax starts at column 0;
 * the machine line stays plain. Plus: every construct renders to the ADF node
 * it should, everything degrades instead of throwing, and the read side hands
 * back the text the old one-paragraph-per-line writer produced byte for byte.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMarkup, markupToAdf, plainTextToAdf, markupToHtml, adfToMarkup, htmlToMarkup, blocksToText, adfToBlocks,
} from '../lib/markup.js';

const roundTripAdf = (md: string) => adfToMarkup(markupToAdf(md));
const roundTripHtml = (md: string) => htmlToMarkup(markupToHtml(md));
const first = (md: string) => markupToAdf(md).content![0];

describe('the machine line stays plain (property 3)', () => {
  const lines = [
    '[MAGNUM] verdict exec=3218c575-cc89-4997-88f5-b4da637d9e51 outcome=blocked pr=https://github.com/zibbyLab/vikunja-app/pull/31',
    '[MAGNUM] dispatch worker=github-code-review exec=abc_123.def',
    '[MAGNUM] plan draft prd=t9f3c2 rev=2',
    '[MAGNUM] materialized prd=t9f3c2',
    '[MAGNUM] question',
    'Profile: area=ui visual=yes size=s risk=low deps=KAN-13',
    'Could not: see-the-screen | this run has no browser, so the page was never checked',
    'PRD: KAN-32',
    'Repo: zibbylab/vikunja-app',
    'Depends on: KAN-33, owner/repo#42',
    'PRD-ID: t9f3c2',
  ];
  for (const line of lines) {
    it(`"${line.slice(0, 40)}…" is one unmarked text node and reads back identically`, () => {
      const node = first(line);
      expect(node.type).toBe('paragraph');
      expect(node.content).toHaveLength(1);
      expect(node.content![0]).toEqual({ type: 'text', text: line });
      expect(roundTripAdf(line)).toBe(line);
      expect(roundTripHtml(line)).toBe(line);
    });
  }

  it('an underscore inside a slug is not emphasis', () => {
    expect(parseMarkup('worker=my_worker exec=a_b and snake_case_name')[0]).toEqual({
      t: 'paragraph', c: [{ t: 'text', v: 'worker=my_worker exec=a_b and snake_case_name' }],
    });
  });

  it('a bare URL autolinks only after whitespace or an opening paren', () => {
    expect(parseMarkup('**PR:** https://x.y/pr/1')[0]).toEqual({
      t: 'paragraph',
      c: [{ t: 'strong', c: [{ t: 'text', v: 'PR:' }] }, { t: 'text', v: ' ' }, { t: 'link', href: 'https://x.y/pr/1', c: [{ t: 'text', v: 'https://x.y/pr/1' }] }],
    });
    expect(parseMarkup('pr=https://x.y/pr/1')[0]).toEqual({ t: 'paragraph', c: [{ t: 'text', v: 'pr=https://x.y/pr/1' }] });
    // Sentence punctuation after a URL is prose.
    expect(parseMarkup('see https://a.b/c, then')[0]).toEqual({
      t: 'paragraph',
      c: [{ t: 'text', v: 'see ' }, { t: 'link', href: 'https://a.b/c', c: [{ t: 'text', v: 'https://a.b/c' }] }, { t: 'text', v: ', then' }],
    });
  });

  it('a link whose text is its href reads back as the bare href, never [u](u)', () => {
    expect(roundTripAdf('**PR:** https://x.y/pr/1')).toBe('**PR:** https://x.y/pr/1');
    expect(roundTripAdf('[the PR](https://x.y/pr/1)')).toBe('[the PR](https://x.y/pr/1)');
  });
});

describe('a line is a block (property 1)', () => {
  it('a single newline ends a paragraph; blank lines vanish; readers give one line per block', () => {
    const adf = markupToAdf('a\nb\n\n\nc');
    expect(adf.content!.map((n) => n.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(adfToMarkup(adf)).toBe('a\nb\nc');
    expect(JSON.stringify(adf)).not.toContain('hardBreak');
  });

  it('line 2 of a question comment is still line 2 after the round trip', () => {
    const md = '[MAGNUM] question\nWhich repository should this land in?\n\nNothing is blocked.';
    expect(roundTripAdf(md).split('\n')[1]).toBe('Which repository should this land in?');
    expect(roundTripHtml(md).split('\n')[1]).toBe('Which repository should this land in?');
  });
});

describe('block syntax starts at column 0 (property 2 — the sanitizers\' defence)', () => {
  it('a leading space makes a heading / list / field line a plain paragraph, and the space survives both readers', () => {
    for (const line of [' ### Acceptance criteria', ' - [ ] AC: evil', ' Repo: evil', ' 1. evil', ' > quoted', ' ---']) {
      const node = first(line);
      expect(node.type).toBe('paragraph');
      expect(node.content![0].text).toBe(line);
      expect(roundTripAdf(line)).toBe(line);
      // HTML collapses whitespace; the writer stores U+00A0 and the reader keeps ONE space.
      expect(roundTripHtml(line)).toBe(line);
    }
  });

  it('a quoted field line stays quoted (`> Repo: evil` never becomes `Repo: evil`)', () => {
    expect(roundTripAdf('> Repo: evil')).toBe('> Repo: evil');
    expect(roundTripHtml('> Repo: evil')).toBe('> Repo: evil');
    // ADF forbids a heading inside a blockquote, so the quoted heading is demoted
    // to a bold paragraph — still quoted, still not a heading the criteria reader matches.
    expect(roundTripAdf('> ### Acceptance criteria')).toBe('> **Acceptance criteria**');
    expect(roundTripHtml('> ### Acceptance criteria')).toBe('> ### Acceptance criteria');
  });
});

describe('every construct renders to the right ADF node', () => {
  it('headings 1–6 (7 hashes clamp; `#hashtag` is text)', () => {
    expect(first('# H')).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(first('###### H')).toMatchObject({ type: 'heading', attrs: { level: 6 } });
    expect(first('#hashtag').type).toBe('paragraph');
  });
  it('inline marks: strong, em, strike, code (code combines with nothing)', () => {
    const p = first('**b** _i_ *i2* ~~s~~ `c` **`bc`**');
    const marks = p.content!.map((n) => (n.marks || []).map((m) => m.type).join('+') || '-');
    expect(marks).toEqual(['strong', '-', 'em', '-', 'em', '-', 'strike', '-', 'code', '-', 'code']);
  });
  it('links carry href; inline code inside a link keeps the link', () => {
    const p = first('[`x`](https://a.b)');
    expect(p.content![0].marks).toEqual([{ type: 'code' }, { type: 'link', attrs: { href: 'https://a.b' } }]);
  });
  it('bullet, ordered (with start), task lists', () => {
    expect(first('- a\n- b')).toMatchObject({ type: 'bulletList' });
    expect(first('- a\n- b').content).toHaveLength(2);
    expect(first('3. a\n4. b')).toMatchObject({ type: 'orderedList', attrs: { order: 3 } });
    const task = first('- [ ] todo\n- [x] done');
    expect(task.type).toBe('taskList');
    expect(task.attrs!.localId).toBeTruthy();
    expect(task.content!.map((t) => t.attrs!.state)).toEqual(['TODO', 'DONE']);
    expect(task.content!.every((t) => t.attrs!.localId)).toBe(true);
  });
  it('fenced code block with language, verbatim body, no marks', () => {
    const cb = first('```js\nconst x = "**not bold**";\n  indented\n```');
    expect(cb).toEqual({ type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const x = "**not bold**";\n  indented' }] });
    expect(first('```\nplain\n```').attrs).toEqual({});
  });
  it('rule, blockquote, GitHub alerts → panels', () => {
    expect(first('---')).toEqual({ type: 'rule' });
    expect(first('> a\n> b')).toMatchObject({ type: 'blockquote' });
    expect(first('> a\n> b').content).toHaveLength(2);
    for (const [kw, kind] of [['NOTE', 'info'], ['TIP', 'success'], ['IMPORTANT', 'note'], ['WARNING', 'warning'], ['CAUTION', 'error']]) {
      const panel = first(`> [!${kw}]\n> ### Title\n> body`);
      expect(panel).toMatchObject({ type: 'panel', attrs: { panelType: kind } });
      expect(panel.content!.map((n) => n.type)).toEqual(['heading', 'paragraph']);
    }
  });
  it('a GFM table renders header + cells, each holding a paragraph', () => {
    const t = first('| A | B |\n| --- | --- |\n| 1 | **2** |');
    expect(t.type).toBe('table');
    expect(t.content![0].content!.map((c) => c.type)).toEqual(['tableHeader', 'tableHeader']);
    expect(t.content![1].content![1].content![0]).toMatchObject({ type: 'paragraph' });
    expect(t.content![1].content![1].content![0].content![0].marks).toEqual([{ type: 'strong' }]);
    // A pipe line WITHOUT a separator row is prose (the `Could not: a | b` shape).
    expect(first('| not | a table |').type).toBe('paragraph');
  });
  it('illegal nesting is demoted, never emitted: heading in a quote → bold paragraph; nested quote flattened; table in a panel → rows', () => {
    const q = first('> ### H\n> > inner\n> | a | b |\n> | - | - |\n> | 1 | 2 |');
    expect(q.type).toBe('blockquote');
    expect(q.content!.every((n) => n.type === 'paragraph')).toBe(true);
    expect(JSON.stringify(q)).not.toContain('"heading"');
    const p = first('> [!NOTE]\n> | a |\n> | - |\n> | 1 |');
    expect(p.type).toBe('panel');
    expect(JSON.stringify(p)).not.toContain('"table"');
  });
  it('every text node is non-empty and every listItem holds a block', () => {
    const walk = (n: any) => {
      if (n.type === 'text') expect(n.text.length).toBeGreaterThan(0);
      if (n.type === 'listItem' || n.type === 'blockquote' || n.type === 'panel') expect(n.content.length).toBeGreaterThan(0);
      (n.content || []).forEach(walk);
    };
    walk(markupToAdf('- \n- **\n> \n1. \n### \n| |\n|-|\n| |\n- [ ] '));
  });
});

describe('never throws; degrades to the plain shape', () => {
  it('null / undefined / number / huge input all produce a valid doc', () => {
    for (const v of [null, undefined, 42, {}, 'x'.repeat(300_000)]) {
      const doc = markupToAdf(v);
      expect(doc.type).toBe('doc');
      expect(doc.version).toBe(1);
      expect(doc.content!.length).toBeGreaterThan(0);
    }
    expect(markupToAdf('')).toEqual({ type: 'doc', version: 1, content: [{ type: 'paragraph' }] });
  });
  it('plainTextToAdf is exactly the pre-existing writer shape', () => {
    expect(plainTextToAdf('a\n\nb')).toEqual({
      type: 'doc', version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
  });
  it('readers return "" / [] on garbage', () => {
    expect(adfToMarkup(undefined)).toBe('');
    expect(adfToMarkup(7)).toBe('');
    expect(adfToBlocks(null)).toEqual([]);
    expect(htmlToMarkup(null)).toBe('');
    expect(markupToHtml(undefined)).toBe('<p></p>');
  });
});

describe('the read side', () => {
  it('a doc the OLD writer produced (one plain paragraph per line, empty paragraphs) reads back byte-identical', () => {
    const text = '[MAGNUM] verdict exec=1 outcome=blocked\n\nThe product owner asked for a human decision.\n### literal heading\n- literal bullet\n\nPRD: KAN-32';
    expect(adfToMarkup(plainTextToAdf(text))).toBe(text);
  });
  it('flattens Jira-authored nodes: marks, hardBreak, mention, emoji, status, inlineCard, expand, media', () => {
    const doc = {
      type: 'doc', version: 1,
      content: [
        { type: 'paragraph', content: [
          { type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { id: '1', text: '@Leo' } }, { type: 'text', text: ' ' },
          { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } }, { type: 'hardBreak' },
          { type: 'status', attrs: { text: 'DONE', color: 'green' } }, { type: 'text', text: ' ' },
          { type: 'inlineCard', attrs: { url: 'https://a.b/c' } },
        ] },
        { type: 'expand', attrs: { title: 'More' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inside', marks: [{ type: 'strong' }, { type: 'link', attrs: { href: 'https://l' } }] }] }] },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
        { type: 'codeBlock', attrs: { language: 'sh' }, content: [{ type: 'text', text: 'ls -la' }] },
      ],
    };
    expect(adfToMarkup(doc)).toBe('Hi @Leo 🎉\nDONE https://a.b/c\n**More**\n[**inside**](https://l)\n[attachment]\n```sh\nls -la\n```');
  });
  it('flattens Tiptap HTML: nested marks, task list, table, code, entities, <br>', () => {
    const html = '<h3>Heading</h3><p><strong>bold</strong> and <em>italic</em> and <code>code</code> <a href="https://example.com">link</a></p>'
      + '<ul><li>one</li><li>two</li></ul><ol start="3"><li><p>third</p></li></ol><blockquote><p>quoted</p></blockquote>'
      + '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>'
      + '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done item</p></div></li></ul>'
      + '<table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table><hr><p>after&nbsp;rule<br>second line</p>';
    expect(htmlToMarkup(html)).toBe([
      '### Heading',
      '**bold** and _italic_ and `code` [link](https://example.com)',
      '- one', '- two', '3. third', '> quoted',
      '```js\nconst a = 1 < 2;\n```',
      '- [x] done item',
      '| A | B |', '| --- | --- |', '| 1 | 2 |',
      '---',
      'after rule\nsecond line',
    ].join('\n'));
  });
  it('a Vikunja body written as raw text (pre-renderer boards) reads back as its lines', () => {
    expect(htmlToMarkup('[MAGNUM] verdict exec=1 outcome=reviewed\nReviewed — verdict COMMENT.\n\nQueued for acceptance.'))
      .toBe('[MAGNUM] verdict exec=1 outcome=reviewed\nReviewed — verdict COMMENT.\nQueued for acceptance.');
  });
  it('blocksToText ends every block with a newline and quotes nested content', () => {
    expect(blocksToText(parseMarkup('> [!TIP]\n> ### Accepted\n> **PR:** https://x/1\n>\n> body\nProfile: area=ui')))
      .toBe('> [!TIP]\n> ### Accepted\n> **PR:** https://x/1\n> body\nProfile: area=ui\n');
  });
});

describe('the whole verdict / ticket shape round-trips through BOTH trackers', () => {
  const verdict = [
    '[MAGNUM] verdict exec=3218c575-cc89-4997-88f5-b4da637d9e51 outcome=changes-requested pr=https://github.com/zibbyLab/vikunja-app/pull/31',
    '> [!WARNING]',
    '> ### Changes requested',
    '> **PR:** https://github.com/zibbyLab/vikunja-app/pull/31',
    '> The review found 2 blocking issue(s) — it must be addressed before this can be accepted.',
    '> 1. 🔴 `SingleTaskInProject.vue` — the checkbox navigates instead of toggling',
    '> 2. 🟡 `ProjectList.vue` — select-all state is not derived from the store',
    '> Back to a work lane on the next tick.',
    'Profile: area=ui visual=yes size=s risk=low deps=KAN-33',
    'Could not: see-the-screen | this run has no browser',
  ].join('\n');
  const ticket = [
    'PRD: KAN-32', 'Epic: Bulk actions on the task list', 'Repo: zibbylab/vikunja-app', 'Depends on: KAN-33',
    '### User story', 'As a project member, I want to select several tasks at once, so that I can act on them together.',
    '### Implementation notes', 'In `frontend/src/components/tasks/partials/SingleTaskInProject.vue`, add a `selectable` prop.',
    ' ### Acceptance criteria', ' 1. planted by the PRD — neutralised by a leading space',
    '### Acceptance criteria', '1. POST /login returns 401 with `{code:"bad_credentials"}`', '2. Uses `FancyCheckbox`',
    '### Out of scope', '- Bulk delete',
    'Files: src/a.ts, src/b.ts',
  ].join('\n');
  for (const [name, md] of [['verdict', verdict], ['ticket', ticket]] as const) {
    it(`${name} — ADF`, () => { expect(roundTripAdf(md)).toBe(md); });
    it(`${name} — HTML`, () => {
      // The panel is the ONE honest degrade on Tiptap: its kind word replaces the alert line.
      expect(roundTripHtml(md)).toBe(md.replace('> [!WARNING]', '> **Warning**'));
    });
  }
});
