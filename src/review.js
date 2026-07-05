/**
 * @zibby/skills/review — the review-domain memory helpers, shared by the
 * gitlab-code-review and github-code-review templates (both already depend on
 * @zibby/skills). Kept OUT of the generic @zibby/core kernel: this is
 * review-specific (findings/verdict schema + the review→reply memory transport),
 * and it lives next to kvMemory.js, whose backend route + scope it mirrors.
 *
 *   import { buildReviewRecord, parseReviewMemory, summarizeForPrompt,
 *            storeReviewRecord, recallReviewRecord } from '@zibby/skills/review';
 */
export {
  REVIEW_RECORD_SCHEMA_VERSION,
  REVIEW_RECORD_KIND,
  CONTENT_MAX_BYTES,
  FIELD_MAX_CHARS,
  SEVERITY_TIERS,
  FINDING_STATUSES,
  normalizeSeverity,
  buildReviewRecord,
  upsertReplyOutcome,
  serializeReviewRecord,
  parseReviewMemory,
  summarizeForPrompt,
} from './reviewRecord.js';

export {
  scopeForReviewMemory,
  storeReviewRecord,
  recallReviewRecord,
} from './reviewMemoryIo.js';
