/**
 * Browser Skill
 *
 * Provides Playwright-based browser automation via MCP.
 * Resolves to @zibby/mcp-browser (if installed) or @playwright/mcp as fallback.
 *
 * Call resolve({ sessionPath, workspace }) to get a ready-to-use MCP server
 * config with session-specific args (video dir, viewport, etc.).
 */

import { createRequire } from 'module';
import { join } from 'path';

const _require = createRequire(import.meta.url);

function resolveBrowserBin() {
  if (process.env.MCP_BROWSER_PATH) return process.env.MCP_BROWSER_PATH;
  try {
    return _require.resolve('@zibby/mcp-browser/dist/bin/mcp-browser-zibby.js');
  } catch {
    return null;
  }
}

const VIDEO_RESOLUTION = '1280x720';
const VIEWPORT_SIZE = '1280x720';

/** Headless for MCP args: explicit from graph config, or env (init script / CI). */
function resolveWantHeadless({ headless } = {}) {
  if (headless === true) return true;
  if (headless === false) return false;
  const z = process.env.ZIBBY_HEADLESS;
  return z === '1' || String(z).toLowerCase() === 'true';
}

function withHeadlessArg(args, wantHeadless) {
  const filtered = (args || []).filter((a) => a !== '--headless');
  if (!wantHeadless) return filtered;
  return [...filtered, '--headless'];
}

export const browserSkill = {
  id: 'browser',
  serverName: 'playwright',
  cursorKey: 'playwright-official',
  allowedTools: ['mcp__playwright__*'],
  sessionEnvKey: 'ZIBBY_SESSION_INFO',
  description: 'Playwright Browser MCP Server',
  envKeys: [],
  tools: [],

  promptFragment: `Execute this test using the browser tools available to you. You MUST make actual browser tool calls — do not fabricate results.
If you DO NOT have access to browser tools → return {"success": false, "steps": [], "browserClosed": false, "notes": "No browser tools available"}.
DO NOT return success: true unless you ACTUALLY called browser tools.`,

  resolve({ sessionPath, workspace, nodeName, headless } = {}) {
    const bin = resolveBrowserBin();
    const nodeSessionPath = (sessionPath && nodeName)
      ? join(sessionPath, nodeName)
      : null;
    const outputDir = nodeSessionPath || sessionPath || workspace || 'test-results';
    const wantHeadless = resolveWantHeadless({ headless });

    const env = {};
    if (nodeSessionPath) {
      env.ZIBBY_NODE_SESSION_PATH = nodeSessionPath;
    }
    if (sessionPath) {
      env.ZIBBY_SESSION_PATH = sessionPath;
    }

    if (!bin) {
      // Hard error — `@zibby/mcp-browser` is required, no fallback.
      // The previous fallback to `npx @playwright/mcp` (Microsoft's)
      // silently degraded the browser experience: no stable IDs, no
      // event recording, defaults to looking for Chrome (the Google
      // binary, not Chromium that ships in our base image). When the
      // fallback fired in cloud Fargate the LLM hit
      // "Chrome is not installed" mid-test. Better to fail loud at
      // skill resolve so the deploy/image is fixed properly.
      //
      // To restore the fallback: don't (install `@zibby/mcp-browser`
      // in the runtime — it's installed globally in the Dockerfile,
      // and locally users get it via `npm install` of @zibby/core).
      throw new Error(
        '@zibby/mcp-browser is not installed.\n' +
        '  Cloud:   verify the Fargate image has it (packages/Dockerfile installs it globally alongside @zibby/cli).\n' +
        '  Local:   `npm install @zibby/mcp-browser` in your workflow, or use the global @zibby/cli install (which pulls it transitively).\n' +
        '  Override: set MCP_BROWSER_PATH to the path of mcp-browser-zibby.js.'
      );
    }

    return {
      command: 'node',
      args: withHeadlessArg(
        [
          bin,
          '--isolated',
          `--save-video=${VIDEO_RESOLUTION}`,
          `--viewport-size=${VIEWPORT_SIZE}`,
          `--output-dir=${outputDir}`,
        ],
        wantHeadless,
      ),
      env,
    };
  },
};
