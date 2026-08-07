/**
 * figma-mcp — a STATELESS Figma REST proxy exposed as a remote MCP server.
 *
 * Each request carries the CALLER'S OWN Figma Personal Access Token in a header
 * (`X-Figma-Token`, or `Authorization: Bearer`); we forward it to api.figma.com
 * and hand the result back as MCP tool output. There is no OAuth, no token
 * store, no server-side identity and no secret in this container — which is
 * exactly why it can be hosted for a whole team: the platform never mints or
 * shares a Figma identity, so every call runs under the real permissions of
 * whoever's PAT it is.
 *
 * PACKAGED COPY. Upstream is the first-party `figma-mcp` repo; `src/figma.js`
 * and `src/tools.js` are byte-identical to it (see SIDECAR.md's re-sync rule).
 * THIS file deliberately diverges in ONE dimension — the human-facing onboarding
 * page — because the audiences differ: upstream serves one shared team box where
 * a per-person install name is mandatory, while here each person installs on
 * their own machine. The MCP transport, the PAT handling and the session
 * anti-hijack logic below are the same code, and must stay that way.
 */

import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';
import { figmaRequest } from './figma.js';

const PORT = Number(process.env.PORT || 8090);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
// Base name the install command registers the server under, in the USER'S OWN
// editor config. Only cosmetic here — but people who share one home directory
// with teammates need a per-person name (`claude mcp add` keys config by
// (home)×(workspace)×name, so one shared name means one shared token). The
// onboarding page says so.
const MCP_NAME = process.env.MCP_NAME || 'figma';

// Escape text placed inside <pre>. Critical for the install prompt: it carries a
// `figma-<slug>` placeholder, and a raw `<slug>` is parsed as an HTML tag — the
// browser drops it, so both the visible text AND the copy button lose it.
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const page = (body) =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Connect Figma · MCP</title>
<style>
  :root { --blue:#0a84ff; --ink:#1a1a1a; --muted:#666; --line:#e5e5ea; --bg:#f5f5f7; }
  * { box-sizing: border-box; }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
         margin: 0; padding: 40px 20px env(safe-area-inset-bottom); color: var(--ink); background: #fff; }
  .wrap { max-width: 700px; margin: 0 auto; }
  .logo { font-size: 13px; letter-spacing: .12em; color: var(--muted); text-transform: uppercase; }
  h1 { font-size: 24px; margin: 6px 0 12px; }
  h2 { font-size: 16px; margin: 30px 0 10px; color: #333; }
  h3 { font-size: 14px; margin: 22px 0 6px; color: #333; }
  p  { margin: 8px 0; }
  ol { padding-left: 20px; } li { margin: 4px 0; }
  a { color: var(--blue); }
  .muted { color: var(--muted); font-size: 14px; }
  code { background: var(--bg); border-radius: 4px; padding: 1px 5px; font-size: 90%; }
  pre { background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
        padding: 16px; font: 13px/1.5 'SF Mono', Menlo, ui-monospace, monospace;
        overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 8px 0; }
  .codeblock { position: relative; } .codeblock pre { padding-top: 46px; }
  .copy { position: absolute; top: 8px; right: 8px; background: var(--blue); color: #fff;
          border: none; border-radius: 7px; padding: 7px 15px; font-size: 13px; font-weight: 500; cursor: pointer; }
  .copy:active { opacity: .8; }
  kbd { background: var(--bg); border: 1px solid var(--line); border-bottom-width: 2px;
        border-radius: 5px; padding: 1px 6px; font: 13px ui-monospace, Menlo, monospace; }
  .note { background: #fff8e6; border: 1px solid #f5dca0; border-radius: 10px; padding: 12px 14px; font-size: 14px; margin-top: 22px; }
  hr { border: none; border-top: 1px solid var(--line); margin: 26px 0; }
</style>
</head>
<body><div class="wrap">
${body}
</div>
<script>
function copyBlock(b){
  var p=b.parentElement.querySelector('pre');var text=p.innerText;
  var ok=function(){var t=b.getAttribute('data-label')||b.textContent;b.setAttribute('data-label',t);b.textContent='Copied ✓';setTimeout(function(){b.textContent=t;},1500);};
  function legacy(){var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.top='-1000px';ta.setAttribute('readonly','');document.body.appendChild(ta);ta.select();var done=false;try{done=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);if(done)ok();else window.prompt('Copy manually (Ctrl/Cmd+C):',text);}
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(ok,legacy);}else{legacy();}
}
</script>
</body></html>`;

const mcpUrl = `${PUBLIC_BASE_URL}/mcp`;

// The install lines. The PAT is a placeholder because each person brings their
// OWN — this page never sees, mints or stores one; it only tells you where the
// endpoint is and what header to put your token in.
const claudeCmd = `claude mcp add --transport http ${MCP_NAME} ${mcpUrl} \\
  --header "X-Figma-Token: <YOUR_FIGMA_PAT>"`;
const codexCmd = `[mcp_servers.${MCP_NAME}]
url = "${mcpUrl}"
http_headers = { "X-Figma-Token" = "<YOUR_FIGMA_PAT>" }`;

const homeBody = `
  <div class="logo">Figma · MCP</div>
  <h1>Connect your Figma account</h1>
  <p>This box hosts the Figma MCP server. You connect with <strong>your own</strong> Figma
     Personal Access Token, so every call runs as <strong>you</strong> and sees exactly what
     your Figma account can see. Nothing is stored here — the token rides on each request.</p>

  <h2>① Create a Figma Personal Access Token</h2>
  <ol>
    <li>Open <a href="https://www.figma.com/settings" target="_blank" rel="noopener">figma.com/settings</a> → <strong>Security</strong>.</li>
    <li><strong>Personal access tokens</strong> → <strong>Generate new token</strong>.</li>
    <li>Scopes: at least <code>File content · Read</code> (add <code>Comments · Write</code> to post comments).</li>
    <li><strong>Copy it immediately</strong> — Figma shows it once. It looks like <code>figd_…</code>.</li>
  </ol>

  <h2>② Add the server to your editor</h2>
  <p class="muted">Replace <code>&lt;YOUR_FIGMA_PAT&gt;</code> with the token you just copied.</p>

  <h3>Claude Code / Cursor / Gemini CLI</h3>
  <div class="codeblock">
    <button class="copy" onclick="copyBlock(this)">Copy</button>
    <pre>${esc(claudeCmd)}</pre>
  </div>

  <h3>Codex — append to <code>~/.codex/config.toml</code></h3>
  <div class="codeblock">
    <button class="copy" onclick="copyBlock(this)">Copy</button>
    <pre>${esc(codexCmd)}</pre>
  </div>

  <h3>A Zibby agent on this box</h3>
  <p class="muted">Attach the same URL + header to an agent as a custom MCP server — ask the
     Copilot: <em>“add an MCP server <code>${esc(mcpUrl)}</code> to this agent, header
     <code>X-Figma-Token</code>”</em>. The agent then runs under whoever's PAT you attached.</p>

  <p class="note">
    ⚠️ A PAT is a key to your Figma account. Don't paste it anywhere public, and revoke it from
    Figma's settings when you're done with it. This server never persists it.
    <br>🧑‍🤝‍🧑 Sharing one machine and home directory with teammates? Install under a per-person
    name (<code>${esc(MCP_NAME)}-&lt;your-slug&gt;</code>) instead of plain <code>${esc(MCP_NAME)}</code>
    — <code>claude mcp add</code> keys its config by (home)×(workspace)×name, so one shared name
    means one shared token.
  </p>

  <hr>
  <p class="muted">
    Once installed, ask your agent for Figma work directly — read a file
    (<code>figma_get_file</code>), pull dev-handoff specs (<code>figma_get_node_specs</code>),
    export images (<code>figma_get_images</code>), read/post comments.
    <br>MCP endpoint: <code>${esc(mcpUrl)}</code>
  </p>
`;

// ─── Read the caller's Figma PAT from the request headers ────────────────────
function readToken(req) {
  const x = req.header('x-figma-token');
  if (x) return x.trim();
  const m = (req.header('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
function requireFigmaToken(req, res, next) {
  const t = readToken(req);
  if (!t) {
    return res.status(401).json({
      error: 'missing Figma token — add --header "X-Figma-Token: <PAT>" to the MCP config',
      setup_url: `${PUBLIC_BASE_URL}/connect`,
    });
  }
  req.figmaToken = t;
  next();
}

function buildMcpServer(pat) {
  const server = new McpServer({ name: 'figma-mcp', version: '0.2.0' }, { capabilities: { tools: {} } });
  registerTools(server, { pat, publicBaseUrl: PUBLIC_BASE_URL });
  return server;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'figma-mcp', uptime: process.uptime() });
});

// The onboarding page is served at BOTH '/' and '/connect'.
//
// '/connect' is the one the platform advertises. A sidecar's public surface is
// an explicit ALLOW-LIST of path PREFIXES (`publicPaths` on the spec), and the
// proxy normalizes a bare '/' prefix away to nothing — so a page mounted only at
// the root literally cannot be declared, and would 404 through the proxy. A real
// path segment is what makes it declarable. '/' stays for a bare `docker run`.
app.get(['/', '/connect'], (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(page(homeBody));
});

// ─── MCP: Streamable HTTP transport ──────────────────────────────
// The PAT rides in a header on every request. We bind it to the session at
// initialize and reject later requests whose token differs (anti-hijack).
const sessions = new Map(); // sessionId -> { transport, pat }

app.post('/mcp', requireFigmaToken, async (req, res) => {
  const sid = req.header('mcp-session-id');
  try {
    let transport;
    if (sid && sessions.has(sid)) {
      const sess = sessions.get(sid);
      if (sess.pat !== req.figmaToken) {
        return res.status(403).json({ error: 'session does not belong to this token' });
      }
      transport = sess.transport;
    } else if (!sid && isInitializeRequest(req.body)) {
      const pat = req.figmaToken;
      // One-time PAT check at the door: confirm the token is a real, live Figma
      // credential before opening a session. Stateless, so we can't check a local
      // store like pingcode — we ask Figma (GET /v1/me). Bad tokens get bounced
      // here with a clear 401 instead of confusing per-tool 403s later.
      try {
        await figmaRequest(pat, 'GET', '/v1/me');
      } catch (e) {
        const bad = e.status === 401 || e.status === 403;
        return res.status(bad ? 401 : 502).json({
          error: bad
            ? 'invalid Figma token — check your PAT is valid, not revoked, and has the right scopes'
            : 'could not validate token with Figma (upstream error); try again',
          setup_url: `${PUBLIC_BASE_URL}/connect`,
        });
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newId) => { sessions.set(newId, { transport, pat }); },
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      const server = buildMcpServer(pat);
      await server.connect(transport);
    } else {
      return res.status(400).json({
        jsonrpc: '2.0', id: null,
        error: { code: -32000, message: 'Bad Request: no valid session id (send initialize first)' },
      });
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal' });
  }
});

async function replaySession(req, res) {
  const sid = req.header('mcp-session-id');
  const sess = sid && sessions.get(sid);
  if (!sess || sess.pat !== req.figmaToken) return res.status(404).end();
  await sess.transport.handleRequest(req, res);
}
app.get('/mcp', requireFigmaToken, replaySession);
app.delete('/mcp', requireFigmaToken, replaySession);

app.listen(PORT, () => {
  console.log(`figma-mcp (PAT proxy) listening on :${PORT}`);
  console.log(`  Public URL:   ${PUBLIC_BASE_URL}`);
  console.log(`  MCP endpoint: POST ${PUBLIC_BASE_URL}/mcp  (header: X-Figma-Token: <PAT>)`);
  console.log(`  Onboarding:   ${PUBLIC_BASE_URL}/connect`);
});
