import { describe, it, expect } from 'vitest';
import {
  normalizeBody,
  fingerprint,
  fpMarker,
  extractFp,
  hasSummaryMarker,
  dedupeInline,
  SUMMARY_MARKER,
} from '../review-dedup.js';

describe('review-dedup', () => {
  describe('fingerprint — content-based, line-independent', () => {
    it('same finding text at different lines → SAME fingerprint', () => {
      const a = fingerprint('src/a.js', 'Null pointer risk: `user` may be undefined here.');
      const b = fingerprint('src/a.js', 'Null pointer risk: `user` may be undefined here.');
      expect(a).toBe(b);
    });
    it('ignores line-number mentions + markdown noise', () => {
      const a = fingerprint('src/a.js', 'On line 42, `x` is unused');
      const b = fingerprint('src/a.js', 'On line 87, x is unused');
      expect(a).toBe(b);
    });
    it('different file → different fingerprint', () => {
      expect(fingerprint('a.js', 'same body')).not.toBe(fingerprint('b.js', 'same body'));
    });
    it('genuinely different issue → different fingerprint', () => {
      expect(fingerprint('a.js', 'unused variable x')).not.toBe(fingerprint('a.js', 'SQL injection in query'));
    });
  });

  describe('markers', () => {
    it('round-trips a fingerprint through the marker', () => {
      const fp = fingerprint('a.js', 'issue');
      expect(extractFp(`some body${fpMarker(fp)}`)).toBe(fp);
    });
    it('extractFp returns null when no marker', () => {
      expect(extractFp('plain comment')).toBeNull();
    });
    it('detects the summary marker', () => {
      expect(hasSummaryMarker(`summary${SUMMARY_MARKER}`)).toBe(true);
      expect(hasSummaryMarker('summary')).toBe(false);
    });
    it('a marked body fingerprints the same as its unmarked self (normalize strips the marker)', () => {
      const fp = fingerprint('a.js', 'the issue');
      const marked = `the issue${fpMarker(fp)}`;
      expect(fingerprint('a.js', marked)).toBe(fp);
    });
  });

  describe('dedupeInline', () => {
    const comments = [
      { path: 'a.js', line: 10, body: 'unused variable x' },
      { path: 'a.js', line: 20, body: 'SQL injection risk' },
    ];
    it('posts all when nothing exists yet + stamps markers', () => {
      const { toPost, skipped } = dedupeInline(comments, []);
      expect(skipped).toBe(0);
      expect(toPost).toHaveLength(2);
      expect(extractFp(toPost[0].body)).toBe(toPost[0]._fp);
    });
    it('SKIPS a finding whose fingerprint already exists', () => {
      const existing = [fingerprint('a.js', 'unused variable x')];
      const { toPost, skipped } = dedupeInline(comments, existing);
      expect(skipped).toBe(1);
      expect(toPost).toHaveLength(1);
      expect(toPost[0].body).toContain('SQL injection');
    });
    it('skips ALL when everything was already posted (re-review of unchanged code)', () => {
      const existing = comments.map((c) => fingerprint(c.path, c.body));
      const { toPost, skipped } = dedupeInline(comments, existing);
      expect(skipped).toBe(2);
      expect(toPost).toHaveLength(0);
    });
    it('dedupes duplicates WITHIN one batch too', () => {
      const dup = [
        { path: 'a.js', line: 5, body: 'same issue' },
        { path: 'a.js', line: 9, body: 'same issue' },
      ];
      const { toPost, skipped } = dedupeInline(dup, []);
      expect(toPost).toHaveLength(1);
      expect(skipped).toBe(1);
    });
    it('drops entries with no body', () => {
      expect(dedupeInline([{ path: 'a.js' }], []).toPost).toHaveLength(0);
    });
  });
});
