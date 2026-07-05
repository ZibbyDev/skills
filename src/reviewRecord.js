/**
 * reviewRecord — a GENERIC, provider-agnostic structured record for the
 * code-review → comment_reply memory (shared by gitlab-code-review and
 * github-code-review). Replaces the freeform prose kv note with a versioned,
 * queryable record.
 *
 * DELIBERATELY TRANSPORT-AGNOSTIC. This module does NO I/O: it only builds,
 * serializes, parses and renders the record. WHO stores/recalls it (the JS node
 * vs the LLM via kv_store/kv_recall) is a separate wiring decision — these pure
 * functions are correct either way. The per-PR/MR KEY stays provider-specific
 * (reviewMemoryScopeFor in each review-node.js); the record BODY here carries
 * zero provider fields (identity lives in the key, not the body).
 *
 * Contract facts this module mirrors (source of truth = backend
 * src/handlers/review-memory.js + packages/skills/src/kvMemory.js):
 *   - kv `content` is a STRING, hard-capped at 200KB (CONTENT_MAX). We serialize
 *     to a string and truncate deterministically to fit — an over-cap store is
 *     rejected (HTTP 400) and SILENTLY lost, so truncation must happen here,
 *     before the write.
 *   - kv also has an optional `metadata` OBJECT channel; parseReviewMemory
 *     therefore accepts an already-parsed object too, so the record can ride in
 *     either channel without changing this code.
 *
 * Reviewed by two adversarial design agents (2026-07-04): schema aligned to the
 * REAL finding shape ({file,line,severity,category,claim,evidence,suggestion,
 * confidence}); replies modeled as an IDEMPOTENT findingId→status set (NOT an
 * append log, which double-appends on webhook redelivery); headSha carried but
 * treated as advisory (its plumbing is deferred — today it is undefined).
 */

export const REVIEW_RECORD_SCHEMA_VERSION = 1;
export const REVIEW_RECORD_KIND = 'review-record';

// Mirror backend review-memory.js CONTENT_MAX (200KB). Kept as a local constant
// (no cross-package dep); if the backend cap changes, change it here too.
export const CONTENT_MAX_BYTES = 200 * 1024;
// Per-field cap so one pathological rationale can't blow the whole budget.
export const FIELD_MAX_CHARS = 2000;

// Normalized severity tiers (generic, provider-neutral) + their rank for sorting
// and truncation priority (lower = more important, kept longest).
export const SEVERITY_TIERS = ['blocker', 'should-fix', 'nit'];
const SEVERITY_RANK = { blocker: 0, 'should-fix': 1, nit: 2 };

// Finding status lifecycle. 'open' at review time; a reply may set 'conceded'
// (agent agreed with pushback), 'held' (agent defended), or 'resolved'.
export const FINDING_STATUSES = ['open', 'conceded', 'held', 'resolved'];

/**
 * Normalize the review's free-form / emoji severity into a stable tier.
 * The real review schema defaults severity to '🟡'; reviews also emit 🔴/🟢 and
 * words. Anything unrecognized falls back to 'should-fix' (never throws).
 */
export function normalizeSeverity(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return 'should-fix';
  if (s.includes('🔴') || s.includes('blocker') || s.includes('critical') || s.includes('high')) return 'blocker';
  if (s.includes('🟢') || s.includes('nit') || s.includes('minor') || s.includes('low') || s.includes('info')) return 'nit';
  if (s.includes('🟡') || s.includes('should') || s.includes('medium') || s.includes('warn')) return 'should-fix';
  return 'should-fix';
}

const clamp = (v, max) => {
  const s = v == null ? '' : String(v);
  return s.length > max ? s.slice(0, max) : s;
};

const utf8Bytes = (str) => {
  // Byte length as the backend/DDB counts it. Buffer in node; TextEncoder fallback.
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(str, 'utf8');
  }
  return new TextEncoder().encode(str).length;
};

/**
 * Build a fresh review record from the review node's (post-verification)
 * findings. `findings` is the REAL review shape:
 *   { file, line?, severity, category, claim, evidence, suggestion?, confidence? }
 * Assigns stable ids (f1..fN), normalizes severity, caps long text, status:'open'.
 * `nowIso` is injected (callers pass new Date().toISOString()) so this stays pure.
 */
export function buildReviewRecord({
  headSha = null,
  verdict = 'COMMENT',
  objectivesChecked = false,
  findings = [],
  nowIso = null,
} = {}) {
  const list = Array.isArray(findings) ? findings : [];
  return {
    schemaVersion: REVIEW_RECORD_SCHEMA_VERSION,
    kind: REVIEW_RECORD_KIND,
    headSha: headSha || null, // advisory; plumbing deferred (today undefined)
    verdict: String(verdict || 'COMMENT'),
    objectivesChecked: !!objectivesChecked,
    reviewedAt: nowIso || null,
    findings: list.map((f, i) => ({
      id: `f${i + 1}`,
      file: clamp(f?.file, 512),
      line: f?.line == null ? null : f.line,
      severity: normalizeSeverity(f?.severity),
      category: clamp(f?.category, 64),
      claim: clamp(f?.claim, FIELD_MAX_CHARS),
      evidence: clamp(f?.evidence, FIELD_MAX_CHARS),
      suggestion: clamp(f?.suggestion, FIELD_MAX_CHARS),
      confidence: typeof f?.confidence === 'number' ? f.confidence : null,
      status: 'open',
    })),
  };
}

/**
 * Record the OUTCOME of a comment_reply against a finding. IDEMPOTENT: it SETS
 * findings[id].status (and an optional one-line note) — running the same reply
 * twice (webhook redelivery) yields the identical record, no double-append.
 * Returns a NEW record (does not mutate the input). If findingId is unknown, the
 * record is returned unchanged (best-effort, never throws).
 */
export function upsertReplyOutcome(record, { findingId, status, note } = {}) {
  if (!record || !Array.isArray(record.findings)) return record;
  const nextStatus = FINDING_STATUSES.includes(status) ? status : 'held';
  return {
    ...record,
    findings: record.findings.map((f) =>
      f.id === findingId
        ? { ...f, status: nextStatus, replyNote: clamp(note, FIELD_MAX_CHARS) }
        : f
    ),
  };
}

/**
 * Serialize a record to a string that FITS CONTENT_MAX_BYTES. Deterministic:
 * findings are stably sorted by (severityRank, file, line, id); if still over
 * budget, the LOWEST-priority findings are dropped until it fits and
 * `truncated:true` is set. Text fields are already capped by buildReviewRecord.
 */
export function serializeReviewRecord(record) {
  if (!record) return '';
  const sorted = [...(record.findings || [])].sort((a, b) => {
    const r = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (r !== 0) return r;
    const fa = a.file || '', fb = b.file || '';
    if (fa !== fb) return fa < fb ? -1 : 1;
    const la = Number(a.line) || 0, lb = Number(b.line) || 0;
    if (la !== lb) return la - lb;
    return (a.id || '') < (b.id || '') ? -1 : 1;
  });
  let working = { ...record, findings: sorted };
  let str = JSON.stringify(working);
  if (utf8Bytes(str) <= CONTENT_MAX_BYTES) return str;
  // Drop lowest-priority findings (end of the sorted list) until it fits.
  const kept = [...sorted];
  working = { ...record, findings: kept, truncated: true };
  while (kept.length > 0 && utf8Bytes(JSON.stringify(working)) > CONTENT_MAX_BYTES) {
    kept.pop();
    working = { ...record, findings: kept, truncated: true };
  }
  return JSON.stringify(working);
}

const looksLikeRecord = (o) =>
  o && typeof o === 'object' && !Array.isArray(o) && o.kind === REVIEW_RECORD_KIND;

/**
 * Tolerant reader — NEVER throws. Accepts whatever kv_recall returns for the
 * value (a JSON string, an already-parsed metadata object, a legacy prose
 * string, an {error} envelope, null/'').
 * Returns one of:
 *   { kind:'empty' }                         — nothing usable
 *   { kind:'record',  record, future?:bool } — a structured record (future=newer schemaVersion)
 *   { kind:'legacy',  legacyNote:string }    — an old freeform note; advisory only
 */
export function parseReviewMemory(raw) {
  if (raw == null) return { kind: 'empty' };
  // Already-parsed object (metadata channel, or an {error} envelope).
  if (typeof raw === 'object') {
    if (!Array.isArray(raw) && typeof raw.error === 'string') return { kind: 'empty' };
    if (looksLikeRecord(raw)) {
      const future = Number(raw.schemaVersion) > REVIEW_RECORD_SCHEMA_VERSION;
      return { kind: 'record', record: raw, future };
    }
    // Some other object — render nothing structured; treat as advisory JSON text.
    return { kind: 'legacy', legacyNote: safeStringify(raw) };
  }
  if (typeof raw !== 'string') return { kind: 'empty' };
  const s = raw.trim();
  if (!s) return { kind: 'empty' };
  // Try JSON — a structured record arrives as a stringified object.
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    // Not JSON → a legacy freeform prose note. The common rollout case.
    return { kind: 'legacy', legacyNote: s };
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
    return { kind: 'empty' };
  }
  if (looksLikeRecord(parsed)) {
    const future = Number(parsed.schemaVersion) > REVIEW_RECORD_SCHEMA_VERSION;
    return { kind: 'record', record: parsed, future };
  }
  // Parsed JSON but not a record (e.g. a bare string/number/array) → advisory.
  return { kind: 'legacy', legacyNote: s };
}

function safeStringify(o) {
  try { return JSON.stringify(o); } catch { return String(o); }
}

/**
 * Render a parsed memory into prompt text for the review/reply LLM. Compact,
 * human-readable, and it NEVER assumes a shape it didn't verify (a future
 * schemaVersion is surfaced as advisory). Empty → '' (caller omits the block).
 */
export function summarizeForPrompt(parsed) {
  if (!parsed || parsed.kind === 'empty') return '';
  if (parsed.kind === 'legacy') {
    return `Prior review memory (legacy note, advisory only):\n${parsed.legacyNote}`;
  }
  const r = parsed.record || {};
  if (parsed.future) {
    return `Prior review memory (newer format ${r.schemaVersion} — advisory; verify against the live thread):\n${safeStringify(r).slice(0, FIELD_MAX_CHARS)}`;
  }
  const head = [
    `Prior review of this change (verdict: ${r.verdict || 'COMMENT'}${r.headSha ? `, commit ${r.headSha}` : ''}):`,
  ];
  const lines = (r.findings || []).map((f) => {
    const loc = f.file ? `${f.file}${f.line != null ? `:${f.line}` : ''}` : '(general)';
    const st = f.status && f.status !== 'open' ? ` [${f.status}]` : '';
    return `- [${f.severity}] ${loc} — ${f.claim || ''}${st}`;
  });
  if (r.truncated) lines.push('- (…older/lower-severity findings were truncated to fit memory)');
  return [...head, ...lines].join('\n');
}
