import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock backend-client BEFORE importing the skill (same setup as linkedin.test.js)
// so resolveIntegrationToken resolves a variant-specific token per provider.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async (provider) => {
    if (provider === 'linkedin_personal') {
      return { provider: 'linkedin_personal', token: 'secret_li', memberId: 'abc123' };
    }
    return { provider: 'linkedin_business', token: 'secret_li' };
  }),
  clearTokenCache: vi.fn(),
}));

const { linkedinSkill } = await import('../src/linkedin.js');

// A fetch Response-like object (mirrors linkedin.test.js fetchJson()).
function fetchJson(payload, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
  };
}

const IMAGE_URN = 'urn:li:image:C4D00AAA';
const UPLOAD_URL = 'https://li-upload.example.com/upload/abc123';

let tmp;
let imgPath;

beforeEach(() => {
  vi.clearAllMocks();
  tmp = mkdtempSync(join(tmpdir(), 'zibby-li-img-'));
  imgPath = join(tmp, 'card.png');
  // Any bytes — the PUT is mocked; readFileSync just needs a real file.
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// A fetch stub that models the Images-API upload flow + the /rest/posts write.
// Records every call so tests can assert what was (and was NOT) hit.
function installUploadFetch({ postHeaders = { 'x-restli-id': 'urn:li:share:IMG' } } = {}) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/rest/images?action=initializeUpload')) {
      return fetchJson({ value: { uploadUrl: UPLOAD_URL, image: IMAGE_URN } }, { status: 200 });
    }
    if (url === UPLOAD_URL) {
      return fetchJson('', { status: 201 }); // the raw-bytes PUT
    }
    if (url.includes('/v2/userinfo')) {
      return fetchJson({ sub: 'abc123', name: 'Leo Founder' });
    }
    if (url.includes('/rest/posts')) {
      return fetchJson('', { status: 201, headers: postHeaders });
    }
    throw new Error(`unexpected url ${url}`);
  });
  return calls;
}

describe('linkedin_publish_post — imagePath attaches an uploaded image', () => {
  it('uploads the image and posts content.media.id = the uploaded image URN', async () => {
    const calls = installUploadFetch();

    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_publish_post', {
      text: 'Post with a branded card',
      imagePath: imgPath,
      imageAltText: 'A concept card',
    }));

    expect(result.ok).toBe(true);

    // The write body carries the attached media (Posts API 202506 shape).
    const postCall = calls.find((c) => c.url.includes('/rest/posts'));
    const body = JSON.parse(postCall.init.body);
    expect(body.content).toEqual({ media: { id: IMAGE_URN, altText: 'A concept card' } });
    expect(body.author).toBe('urn:li:person:abc123');
    expect(body.lifecycleState).toBe('PUBLISHED');

    // initializeUpload owner = the post author; the raw bytes were PUT with the
    // SAME provider token as the post.
    const initCall = calls.find((c) => c.url.includes('/rest/images?action=initializeUpload'));
    expect(JSON.parse(initCall.init.body)).toEqual({ initializeUploadRequest: { owner: 'urn:li:person:abc123' } });
    const putCall = calls.find((c) => c.url === UPLOAD_URL);
    expect(putCall.init.method).toBe('PUT');
    expect(putCall.init.headers.Authorization).toBe('Bearer secret_li');
    expect(putCall.init.headers['Content-Type']).toBe('image/png');
  });

  it('dry_run:true with imagePath does NOT upload and returns imageWouldAttach:true', async () => {
    const calls = installUploadFetch();

    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_publish_post', {
      text: 'Preview only',
      imagePath: imgPath,
      dry_run: true,
    }));

    expect(result.dryRun).toBe(true);
    expect(result.imageWouldAttach).toBe(true);
    expect(result.imagePath).toBe(imgPath);

    // No image upload + no post on a dry run.
    expect(calls.some((c) => c.url.includes('/rest/images'))).toBe(false);
    expect(calls.some((c) => c.url === UPLOAD_URL)).toBe(false);
    expect(calls.some((c) => c.url.includes('/rest/posts'))).toBe(false);
  });

  it('no imagePath → no content.media and no image upload (unchanged behavior)', async () => {
    const calls = installUploadFetch();
    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_publish_post', { text: 'plain' }));
    expect(result.ok).toBe(true);
    const body = JSON.parse(calls.find((c) => c.url.includes('/rest/posts')).init.body);
    expect(body.content).toBeUndefined();
    expect(calls.some((c) => c.url.includes('/rest/images'))).toBe(false);
  });
});

describe('linkedin_create_draft_post — imagePath attaches an uploaded image', () => {
  it('uploads the image (business provider) and drafts content.media.id = the uploaded URN', async () => {
    const calls = installUploadFetch();

    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_create_draft_post', {
      organizationId: '12345',
      text: 'Org draft with a card',
      imagePath: imgPath,
      imageAltText: 'Alt',
    }));

    expect(result.ok).toBe(true);
    const body = JSON.parse(calls.find((c) => c.url.includes('/rest/posts')).init.body);
    expect(body.content).toEqual({ media: { id: IMAGE_URN, altText: 'Alt' } });
    expect(body.lifecycleState).toBe('DRAFT');

    // initializeUpload owner = the org author urn.
    const initCall = calls.find((c) => c.url.includes('/rest/images?action=initializeUpload'));
    expect(JSON.parse(initCall.init.body)).toEqual({ initializeUploadRequest: { owner: 'urn:li:organization:12345' } });
  });

  it('org dry_run with imagePath does NOT upload and returns imageWouldAttach:true', async () => {
    const calls = installUploadFetch();
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/rest/organizations/12345')) return fetchJson({ id: 12345, localizedName: 'Acme' });
      throw new Error(`unexpected url ${url}`);
    });

    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_create_draft_post', {
      organizationId: '12345',
      text: 'draft preview',
      imagePath: imgPath,
      dry_run: true,
    }));
    expect(result.dryRun).toBe(true);
    expect(result.imageWouldAttach).toBe(true);
    expect(result.imagePath).toBe(imgPath);
    expect(calls.some((c) => c.url.includes('/rest/images'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/rest/posts'))).toBe(false);
  });

  it('surfaces an upload failure as { ok:false, error } without posting', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/rest/images?action=initializeUpload')) {
        return fetchJson({ value: { uploadUrl: UPLOAD_URL, image: IMAGE_URN } });
      }
      if (url === UPLOAD_URL) return fetchJson('boom', { ok: false, status: 500 });
      throw new Error(`unexpected url ${url}`);
    });

    const result = JSON.parse(await linkedinSkill.handleToolCall('linkedin_publish_post', {
      text: 'x', imagePath: imgPath,
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/image upload 500/i);
    // The post was NOT attempted after the upload failed.
    expect(calls.some((c) => c.url.includes('/rest/posts'))).toBe(false);
  });
});
