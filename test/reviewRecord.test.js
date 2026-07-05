import { describe, it, expect } from 'vitest';
import {
  REVIEW_RECORD_SCHEMA_VERSION,
  REVIEW_RECORD_KIND,
  CONTENT_MAX_BYTES,
  normalizeSeverity,
  buildReviewRecord,
  upsertReplyOutcome,
  serializeReviewRecord,
  parseReviewMemory,
  summarizeForPrompt,
} from '../src/reviewRecord.js';

const REAL_FINDINGS = [
  { file: 'src/a.ts', line: 38, severity: '🔴', category: 'security', claim: 'SQLi', evidence: 'concat', suggestion: 'params', confidence: 0.9 },
  { file: 'src/b.ts', line: 7, severity: '🟡', category: 'correctness', claim: 'off-by-one', evidence: 'loop', suggestion: '<=' },
  { file: 'src/c.ts', severity: '🟢', category: 'style', claim: 'nit', evidence: 'x' },
];

describe('normalizeSeverity', () => {
  it('maps emoji to tiers', () => {
    expect(normalizeSeverity('🔴')).toBe('blocker');
    expect(normalizeSeverity('🟡')).toBe('should-fix');
    expect(normalizeSeverity('🟢')).toBe('nit');
  });
  it('maps words + is case-insensitive', () => {
    expect(normalizeSeverity('Blocker')).toBe('blocker');
    expect(normalizeSeverity('should-fix')).toBe('should-fix');
    expect(normalizeSeverity('NIT')).toBe('nit');
    expect(normalizeSeverity('critical')).toBe('blocker');
  });
  it('falls back to should-fix on unknown/empty, never throws', () => {
    expect(normalizeSeverity('')).toBe('should-fix');
    expect(normalizeSeverity(null)).toBe('should-fix');
    expect(normalizeSeverity(undefined)).toBe('should-fix');
    expect(normalizeSeverity(42)).toBe('should-fix');
    expect(normalizeSeverity('purple')).toBe('should-fix');
  });
});

describe('buildReviewRecord', () => {
  it('builds a versioned record from the REAL finding shape', () => {
    const rec = buildReviewRecord({
      verdict: 'REQUEST_CHANGES', objectivesChecked: true, findings: REAL_FINDINGS,
      nowIso: '2026-07-04T00:00:00Z',
    });
    expect(rec.schemaVersion).toBe(REVIEW_RECORD_SCHEMA_VERSION);
    expect(rec.kind).toBe(REVIEW_RECORD_KIND);
    expect(rec.verdict).toBe('REQUEST_CHANGES');
    expect(rec.objectivesChecked).toBe(true);
    expect(rec.reviewedAt).toBe('2026-07-04T00:00:00Z');
    expect(rec.findings).toHaveLength(3);
    expect(rec.findings[0]).toMatchObject({
      id: 'f1', file: 'src/a.ts', line: 38, severity: 'blocker',
      category: 'security', claim: 'SQLi', evidence: 'concat', suggestion: 'params',
      confidence: 0.9, status: 'open',
    });
    expect(rec.findings[2]).toMatchObject({ id: 'f3', line: null, severity: 'nit' });
  });
  it('is pure (no ambient clock) and tolerates empty/garbage findings', () => {
    expect(buildReviewRecord().findings).toEqual([]);
    expect(buildReviewRecord({ findings: null }).findings).toEqual([]);
    expect(buildReviewRecord({ findings: 'x' }).findings).toEqual([]);
    expect(buildReviewRecord().reviewedAt).toBe(null);
  });
  it('caps long text fields', () => {
    const big = 'x'.repeat(50000);
    const rec = buildReviewRecord({ findings: [{ claim: big, evidence: big }] });
    expect(rec.findings[0].claim.length).toBeLessThanOrEqual(2000);
    expect(rec.findings[0].evidence.length).toBeLessThanOrEqual(2000);
  });
});

describe('upsertReplyOutcome — idempotent findingId→status set', () => {
  const base = buildReviewRecord({ findings: REAL_FINDINGS, nowIso: 'T' });
  it('sets status + note on the right finding without mutating input', () => {
    const after = upsertReplyOutcome(base, { findingId: 'f1', status: 'conceded', note: 'agreed' });
    expect(after.findings[0]).toMatchObject({ id: 'f1', status: 'conceded', replyNote: 'agreed' });
    expect(base.findings[0].status).toBe('open'); // input untouched
  });
  it('is IDEMPOTENT — same reply twice yields identical record (webhook redelivery)', () => {
    const once = upsertReplyOutcome(base, { findingId: 'f2', status: 'held', note: 'defended' });
    const twice = upsertReplyOutcome(once, { findingId: 'f2', status: 'held', note: 'defended' });
    expect(twice).toEqual(once);
  });
  it('unknown findingId → unchanged; invalid status → held; bad record → returned as-is', () => {
    expect(upsertReplyOutcome(base, { findingId: 'nope', status: 'held' }).findings).toEqual(base.findings);
    expect(upsertReplyOutcome(base, { findingId: 'f1', status: 'bogus' }).findings[0].status).toBe('held');
    expect(upsertReplyOutcome(null, { findingId: 'f1' })).toBe(null);
    expect(upsertReplyOutcome({}, { findingId: 'f1' })).toEqual({});
  });
});

describe('serializeReviewRecord — deterministic + fits CONTENT_MAX', () => {
  it('round-trips a normal record', () => {
    const rec = buildReviewRecord({ findings: REAL_FINDINGS, nowIso: 'T' });
    const parsed = JSON.parse(serializeReviewRecord(rec));
    expect(parsed.kind).toBe(REVIEW_RECORD_KIND);
    expect(parsed.findings).toHaveLength(3);
  });
  it('sorts deterministically by (severity, file, line, id)', () => {
    const rec = buildReviewRecord({ findings: REAL_FINDINGS, nowIso: 'T' });
    const order = JSON.parse(serializeReviewRecord(rec)).findings.map((f) => f.severity);
    expect(order).toEqual(['blocker', 'should-fix', 'nit']);
  });
  it('truncates deterministically when over CONTENT_MAX, keeping highest severity + setting truncated', () => {
    // 400 findings × ~4KB of capped text ≈ well over 200KB.
    const many = [];
    for (let i = 0; i < 400; i++) {
      many.push({
        file: `src/file${i}.ts`, line: i,
        severity: i === 0 ? '🔴' : '🟢',
        category: 'x', claim: 'c'.repeat(2000), evidence: 'e'.repeat(2000),
      });
    }
    const rec = buildReviewRecord({ findings: many, nowIso: 'T' });
    const str = serializeReviewRecord(rec);
    expect(Buffer.byteLength(str, 'utf8')).toBeLessThanOrEqual(CONTENT_MAX_BYTES);
    const parsed = JSON.parse(str);
    expect(parsed.truncated).toBe(true);
    expect(parsed.findings.length).toBeLessThan(400);
    // The single blocker must survive (highest priority kept).
    expect(parsed.findings.some((f) => f.severity === 'blocker')).toBe(true);
    // Deterministic: same input → same output.
    expect(serializeReviewRecord(buildReviewRecord({ findings: many, nowIso: 'T' }))).toBe(str);
  });
  it('empty record → empty string', () => {
    expect(serializeReviewRecord(null)).toBe('');
  });
});

describe('parseReviewMemory — tolerant, NEVER throws (full case matrix)', () => {
  it('1. null/undefined/empty → empty', () => {
    expect(parseReviewMemory(null).kind).toBe('empty');
    expect(parseReviewMemory(undefined).kind).toBe('empty');
    expect(parseReviewMemory('').kind).toBe('empty');
    expect(parseReviewMemory('   ').kind).toBe('empty');
  });
  it('2. legacy prose string (JSON.parse fails) → legacy advisory', () => {
    const p = parseReviewMemory('human pushed back on finding X; conceded — rationale Z');
    expect(p.kind).toBe('legacy');
    expect(p.legacyNote).toContain('pushed back');
  });
  it('3. a serialized record string → record', () => {
    const rec = buildReviewRecord({ findings: REAL_FINDINGS, nowIso: 'T' });
    const p = parseReviewMemory(serializeReviewRecord(rec));
    expect(p.kind).toBe('record');
    expect(p.record.findings).toHaveLength(3);
    expect(p.future).toBe(false);
  });
  it('4. already-parsed metadata object record → record', () => {
    const rec = buildReviewRecord({ findings: REAL_FINDINGS, nowIso: 'T' });
    const p = parseReviewMemory(rec); // object, not string
    expect(p.kind).toBe('record');
  });
  it('5. {error} envelope (string or object) → empty', () => {
    expect(parseReviewMemory(JSON.stringify({ error: 'not found' })).kind).toBe('empty');
    expect(parseReviewMemory({ error: 'boom' }).kind).toBe('empty');
  });
  it('6. newer schemaVersion → record with future=true', () => {
    const future = { kind: REVIEW_RECORD_KIND, schemaVersion: 999, findings: [] };
    const p = parseReviewMemory(JSON.stringify(future));
    expect(p.kind).toBe('record');
    expect(p.future).toBe(true);
  });
  it('7. parsed JSON that is NOT a record (bare string/number/array/object) → legacy', () => {
    expect(parseReviewMemory('42').kind).toBe('legacy');
    expect(parseReviewMemory('"just a quoted string"').kind).toBe('legacy');
    expect(parseReviewMemory('[1,2,3]').kind).toBe('legacy');
    expect(parseReviewMemory({ some: 'obj' }).kind).toBe('legacy');
  });
  it('never throws on hostile input', () => {
    for (const v of [NaN, Symbol('x'), () => {}, 0, false, {}, [], '{bad json']) {
      expect(() => parseReviewMemory(v)).not.toThrow();
    }
  });
});

describe('summarizeForPrompt', () => {
  it('renders a record with findings + status', () => {
    let rec = buildReviewRecord({ verdict: 'REQUEST_CHANGES', findings: REAL_FINDINGS, nowIso: 'T' });
    rec = upsertReplyOutcome(rec, { findingId: 'f1', status: 'held' });
    const out = summarizeForPrompt(parseReviewMemory(serializeReviewRecord(rec)));
    expect(out).toContain('REQUEST_CHANGES');
    expect(out).toContain('src/a.ts:38');
    expect(out).toContain('[held]');
  });
  it('renders a legacy note as advisory + empty → ""', () => {
    expect(summarizeForPrompt(parseReviewMemory('old note'))).toContain('advisory');
    expect(summarizeForPrompt(parseReviewMemory(null))).toBe('');
    expect(summarizeForPrompt(null)).toBe('');
  });
});

describe('end-to-end round-trip (build → reply → serialize → parse → summarize)', () => {
  it('survives the full loop with continuity', () => {
    let rec = buildReviewRecord({ verdict: 'REQUEST_CHANGES', findings: REAL_FINDINGS, nowIso: 'T' });
    const stored = serializeReviewRecord(rec);
    const recalled = parseReviewMemory(stored);
    expect(recalled.kind).toBe('record');
    const replied = upsertReplyOutcome(recalled.record, { findingId: 'f2', status: 'conceded', note: 'good point' });
    const stored2 = serializeReviewRecord(replied);
    const recalled2 = parseReviewMemory(stored2);
    expect(recalled2.record.findings.find((f) => f.id === 'f2').status).toBe('conceded');
  });
});
