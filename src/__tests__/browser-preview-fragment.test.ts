import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { browserSkill } from '../browser.js';

/**
 * The dev-server preview recipe lives in the browser skill's promptFragment —
 * the ONE place, inherited by every node that binds SKILLS.BROWSER, so no
 * template author has to remember the URL shape. TWO-PLACES pin (cross-repo):
 * the env names asserted here are written by the self-host dispatcher
 * (selfhosted/preview/config.js — its preview-egress-origin.test.js pins the
 * writer side).
 */

const VARS = ['PREVIEW_BASE_URL', 'PREVIEW_TOKEN'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

const fragment = () => (browserSkill.promptFragment as () => string)();

describe('browser skill preview prompt fragment', () => {
  test('no preview env ⇒ the historical fragment, byte-identical (cloud / preview-off boxes unchanged)', () => {
    const f = fragment();
    expect(f).toContain('You MUST make actual browser tool calls');
    expect(f).not.toContain('PREVIEW_BASE_URL');
    expect(f).not.toContain('preview');
  });

  test('preview env present ⇒ the recipe is injected, by ENV NAME', () => {
    process.env.PREVIEW_BASE_URL = 'http://control-plane:3002/preview/exec-1';
    process.env.PREVIEW_TOKEN = 'pv1.exec-1.999.aabb';
    const f = fragment();
    // the recipe's three load-bearing facts: the env names, the 0.0.0.0 bind,
    // and the never-localhost warning
    expect(f).toContain('$PREVIEW_BASE_URL/<port>/?pvt=$PREVIEW_TOKEN');
    expect(f).toContain('0.0.0.0');
    expect(f).toMatch(/NEVER navigate to http:\/\/localhost/);
    // the DON'T-set-a-base fact. The platform routes root-absolute assets back
    // itself (preview-server.js ROOT_COOKIE); an agent that "fixes" the blank
    // page by pointing Vite's `base` at the preview prefix instead lands in a
    // redirect loop — observed twice in one real run, 2026-08-18, before it
    // started hand-writing prefix-rewriting middleware.
    expect(f).toMatch(/do NOT set a base path/i);
    expect(f).toMatch(/basePath|PUBLIC_URL/);
    expect(f).toMatch(/LOOP/);
    // the base contract survives untouched
    expect(f).toContain('You MUST make actual browser tool calls');
  });

  test('the token VALUE never leaks into the prompt (security invariant #4)', () => {
    process.env.PREVIEW_BASE_URL = 'http://control-plane:3002/preview/exec-1';
    process.env.PREVIEW_TOKEN = 'pv1.exec-1.999.deadbeefsecret';
    expect(fragment()).not.toContain('deadbeefsecret');
  });

  test('half-injected env (either var missing) fails closed to the base fragment', () => {
    process.env.PREVIEW_BASE_URL = 'http://control-plane:3002/preview/exec-1';
    expect(fragment()).not.toContain('PREVIEW_TOKEN');
  });
});
