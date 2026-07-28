import express from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';
import { getPingCodeOAuth } from './pingcode.js';

const PORT = Number(process.env.PORT || 8090);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// Base-path awareness: when this app sits behind a reverse proxy under a
// prefix (e.g. https://host/sidecars/pingcode/... with the prefix STRIPPED
// before the request reaches us), every in-page link must carry that prefix —
// a root-relative <a href="/oauth/start"> would escape the mount. The prefix
// comes from PUBLIC_BASE_PATH, or is derived from PUBLIC_BASE_URL's path.
// Empty (direct exposure) keeps today's behaviour byte-identical.
function normalizeBasePath(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/\/+$/, '');
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s;
}
const BASE_PATH = normalizeBasePath(
  process.env.PUBLIC_BASE_PATH ?? new URL(PUBLIC_BASE_URL).pathname,
);

const pc = getPingCodeOAuth();

// state → { mcpToken: <existing-for-renew> | null, createdAt }
const pendingAuth = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuth.entries()) {
    if (now - v.createdAt > STATE_TTL_MS) pendingAuth.delete(k);
  }
}, 60_000).unref();

const newMcpToken = () => 'mcp_' + randomBytes(32).toString('hex');

// Escape text placed inside <pre>. Critical for the install prompts: they carry
// a `pingcode-<slug>` placeholder, and a raw `<slug>` is parsed as an HTML tag —
// the browser drops it, so both the visible text AND the copy button (which
// reads innerText) lose the placeholder, yielding a broken `pingcode-` command.
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const html = (body) =>
  `<!doctype html>
<meta charset="utf-8">
<title>pingcode-mcp</title>
<style>
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
         padding: 48px 24px; max-width: 720px; margin: 0 auto; color: #1a1a1a; }
  h2 { font-size: 22px; margin: 0 0 16px; }
  p  { margin: 8px 0; }
  pre { background: #f5f5f7; border: 1px solid #e5e5ea; border-radius: 8px;
        padding: 16px; font: 13px/1.5 'SF Mono', Menlo, monospace;
        overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .muted { color: #666; font-size: 14px; }
  .ok { color: #1d8a3a; }
  .err { color: #b91c1c; }
  a.btn { display: inline-block; background: #0a84ff; color: #fff; padding: 10px 18px;
          border-radius: 8px; text-decoration: none; font-weight: 500; }
  h3 { font-size: 15px; margin: 28px 0 8px; color: #333; }
  .codeblock { position: relative; }
  .codeblock pre { padding-top: 42px; }
  .copy { position: absolute; top: 8px; right: 8px; background: #0a84ff; color: #fff;
          border: none; border-radius: 6px; padding: 6px 14px; font-size: 13px;
          font-weight: 500; cursor: pointer; }
  .copy:hover { background: #0070e0; }
</style>
${body}
<script>
function copyBlock(b){
  var p=b.parentElement.querySelector('pre');var text=p.innerText;
  var ok=function(){var t=b.getAttribute('data-label')||b.textContent;b.setAttribute('data-label',t);b.textContent='已复制 ✓';setTimeout(function(){b.textContent=t;},1500);};
  function legacy(){var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.top='-1000px';ta.setAttribute('readonly','');document.body.appendChild(ta);ta.select();var done=false;try{done=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);if(done)ok();else window.prompt('手动复制 (Ctrl/Cmd+C):',text);}
  // navigator.clipboard only exists in a secure context (HTTPS/localhost); this
  // page is served over plain HTTP, so fall back to execCommand there.
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(ok,legacy);}else{legacy();}
}
</script>`;

async function requireBearer(req, res, next) {
  const auth = req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'missing bearer token' });
  if (!(await pc.hasSlot(m[1]))) {
    return res.status(401).json({
      error: 'unknown or revoked mcp_token',
      authorize_url: `${PUBLIC_BASE_URL}/oauth/start`,
    });
  }
  req.mcpToken = m[1];
  next();
}

function buildMcpServer(mcpToken) {
  const server = new McpServer(
    { name: 'pingcode-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server, { mcpToken, publicBaseUrl: PUBLIC_BASE_URL });
  return server;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'pingcode-mcp', uptime: process.uptime() });
});

app.get('/', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html(`
    <h2>pingcode-mcp</h2>
    <p>Click below to authorize PingCode and get your Claude Code setup command.</p>
    <p style="margin-top:24px"><a class="btn" href="${BASE_PATH}/oauth/start">授权 PingCode</a></p>
    <p class="muted" style="margin-top:32px">
      Endpoint: <code>POST ${PUBLIC_BASE_URL}/mcp</code>
    </p>
  `));
});

// ─── OAuth: kick off ─────────────────────────────────────────────
// /oauth/start              → first-time: callback will mint a new MCP_TOKEN
// /oauth/start?renew=mcp_xx → renew: callback updates the existing slot's
//                              PingCode tokens, MCP_TOKEN unchanged
app.get('/oauth/start', async (req, res) => {
  const renewToken = req.query.renew ? String(req.query.renew) : null;
  if (renewToken && !(await pc.hasSlot(renewToken))) {
    return res.status(400).set('Content-Type', 'text/html; charset=utf-8').send(html(`
      <h2 class="err">⚠️ 找不到这个 MCP_TOKEN</h2>
      <p>你提供的 renew 值不存在或已被吊销。请走<a href="${BASE_PATH}/oauth/start">新用户授权</a>重新生成一个。</p>
    `));
  }
  const state = randomUUID();
  pendingAuth.set(state, { mcpToken: renewToken, createdAt: Date.now() });
  res.redirect(302, pc.authorizeUrl(state));
});

// ─── OAuth: callback ─────────────────────────────────────────────
// PingCode redirects user here after consent.
// MUST match the redirect URI configured in the PingCode app.
app.get('/oauth/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (!code) {
    return res.status(400).send(html(`<h2 class="err">Missing authorization code</h2>`));
  }
  // PingCode does NOT echo back the `state` param on the callback — it returns
  // `code` + `domain` instead. So we can't key on state. Strategy:
  //   1) if state is present and matches a pending entry, use it (best case)
  //   2) else consume the most-recent pending entry from /oauth/start
  //      (fine for low-concurrency self-serve onboarding; carries renew info)
  //   3) else fall back to a fresh first-time onboarding
  let entry = state ? pendingAuth.get(state) : null;
  if (entry) {
    pendingAuth.delete(state);
  } else {
    let newest = null, newestKey = null;
    for (const [k, v] of pendingAuth.entries()) {
      if (!newest || v.createdAt > newest.createdAt) { newest = v; newestKey = k; }
    }
    if (newestKey) { entry = newest; pendingAuth.delete(newestKey); }
    else { entry = { mcpToken: null, createdAt: Date.now() }; }
  }

  try {
    const tokens = await pc.exchangeCode(code);
    // Who just authorized? Because PingCode doesn't echo `state`, the pending-
    // entry fallback above can hand a renew slot to the WRONG callback under
    // concurrency (or to an attacker racing a victim's renew on a public
    // deployment). Identity is the real key: a renew must come from the SAME
    // PingCode user the slot already belongs to.
    const userId = await pc.fetchUserId(tokens.access_token);

    if (entry.mcpToken) {
      // ── renew flow: update existing slot, keep MCP_TOKEN unchanged ──
      const existing = (await pc.store.get(entry.mcpToken)) || {};
      const boundId = existing.pingcode_user_id || null;
      // Bound slot: reject a different identity, AND fail closed when the
      // identity of the incoming consent can't be established at all.
      if (boundId && userId !== boundId) {
        return res.status(403).send(html(`
          <h2 class="err">⚠️ 续签被拒绝:账号不一致</h2>
          <p>这个 renew 链接属于另一个 PingCode 账号。请用当初授权这个 MCP_TOKEN 的
          PingCode 账号登录后重试;或者走<a href="${BASE_PATH}/oauth/start">新用户授权</a>生成自己的 MCP_TOKEN。</p>
        `));
      }
      // Legacy slot with no recorded identity (pre-migration): accept once and
      // bind it now, so every later renew is identity-checked.
      await pc.saveTokens(entry.mcpToken, {
        ...existing,
        ...tokens,
        pingcode_user_id: boundId || userId || null,
      });
      return res.send(html(`
        <h2 class="ok">✅ PingCode 重新授权完成</h2>
        <p>你的 MCP_TOKEN <strong>没变</strong>，Claude Code 配置不用动。</p>
        <p>直接回到对话, 让 agent 重试刚才那个工具调用就行。</p>
        <p class="muted">下次过期大约在 90 天后。</p>
      `));
    }

    // ── first-time flow: mint a fresh MCP_TOKEN ──
    const mcpToken = newMcpToken();
    await pc.saveTokens(mcpToken, {
      ...tokens,
      created_at: Date.now(),
      // Remember whose slot this is, so future renews can be identity-bound.
      pingcode_user_id: userId || null,
    });

    // Two SEPARATE copy-paste prompts, one per agent. Each is a self-contained
    // natural-language prompt: paste it to the agent and it installs itself, no
    // hand-typed commands. Codex has no `add` for HTTP servers, so its prompt
    // carries a config.toml block; Codex sends http_headers verbatim, so a
    // static Authorization header authenticates like Claude's --header. Each
    // block gets a top-right copy button (copyBlock in the page script).
    const mcpUrl = `${PUBLIC_BASE_URL}/mcp`;
    // The MCP server NAME must be UNIQUE per human AND re-derivable inside any
    // session. `claude mcp add` keys config by (home)×(workspace)×name and refuses
    // to overwrite an existing name — and (verified live) teammates here can share
    // BOTH the home dir and the workspace, so a fixed `pingcode` makes the 2nd
    // user collide, and when several load together each agent must pick its own.
    // Nothing on disk is per-user (shared files get clobbered), so we can't store
    // a name — the agent must COMPUTE it, at install and at use, from the only
    // per-person signal that exists here: the GIT_AUTHOR_EMAIL env var (verified
    // distinct per teammate, e.g. alice@example.com vs alice-1@example.com). The server can't
    // see that value, so it emits a self-instructing prompt telling the agent to
    // read GIT_AUTHOR_EMAIL, slugify it (@ and . → -), and name the server
    // pingcode-<slug>. (The connect-pingcode skill reinforces this + the matching
    // selection rule.) We deliberately do NOT ship a runnable one-liner carrying a
    // `<...>` literal — `<`/`>` are shell redirection, so the command must be built
    // AFTER substitution, never pasted into a shell verbatim.
    const claudePrompt = `请帮我安装 PingCode 的 MCP 服务器。
1) 先在当前会话运行 \`echo $GIT_AUTHOR_EMAIL\` 拿到我的邮箱, 把里面的 @ 和 . 都替换成 - 得到 slug (例如 alice@example.com → alice-example-com)。
2) 然后运行这条命令 (把 <slug> 换成上一步算出来的值, 别原样带着尖括号跑):
claude mcp add --transport http pingcode-<slug> ${mcpUrl} --header "Authorization: Bearer ${mcpToken}"
命令成功后告诉我装好了即可。注意: 刚装的 MCP 工具这一轮还不会加载, 你不用在本轮去搜索、调用或验证 pingcode 工具 —— 我下一条消息发出来时就能用了。`;
    const codexPrompt = `请帮我安装 PingCode 的 MCP 服务器。
1) 先运行 \`echo $GIT_AUTHOR_EMAIL\` 拿到我的邮箱, 把 @ 和 . 都替换成 - 得到 slug (例如 alice@example.com → alice-example-com)。
2) 把下面这一节写入 ~/.codex/config.toml (把 <slug> 换成上一步的值; 没有文件就新建, 已有就追加这一节), 写好后告诉我即可:
[mcp_servers.pingcode-<slug>]
url = "${mcpUrl}"
http_headers = { "Authorization" = "Bearer ${mcpToken}" }
注意: 你不用在本轮验证或调用 pingcode 工具, 我重启 Codex 后下次对话就能用了。`;
    return res.send(html(`
      <h2 class="ok">✅ PingCode 授权成功</h2>
      <p>按你用的工具<strong>二选一</strong>: 复制对应的整段, 粘贴给你的 agent —— 它会自动帮你装好 PingCode MCP, 你不用自己敲命令。</p>

      <h3>① 我用 Claude Code</h3>
      <div class="codeblock">
        <button class="copy" onclick="copyBlock(this)">复制</button>
        <pre>${esc(claudePrompt)}</pre>
      </div>

      <h3>② 我用 Codex</h3>
      <div class="codeblock">
        <button class="copy" onclick="copyBlock(this)">复制</button>
        <pre>${esc(codexPrompt)}</pre>
      </div>

      <p class="muted">
        这里面包含你的专属 MCP_TOKEN, 相当于你的 PingCode 钥匙, 请勿外发或贴到公开场合。
        <br>装一次即可, 之后聊天直接让 agent 用 PingCode 工具。有效期 90 天, 过期前会提示你点链接续签 (MCP_TOKEN 不变)。
      </p>
    `));
  } catch (e) {
    console.error('OAuth callback failed:', e);
    return res.status(500).send(html(`<h2 class="err">授权失败</h2><pre>${esc(e.message)}</pre>`));
  }
});

// ─── MCP: Streamable HTTP transport ──────────────────────────────
// Sessions must persist across requests: the client sends `initialize`
// first (no session id) and the server returns a Mcp-Session-Id header;
// every later request (tools/list, tools/call, ...) carries that header.
// We key live transports by session id. Each session is bound to the
// mcpToken that created it, so a session always acts as that one user.
const sessions = new Map(); // sessionId -> { transport, mcpToken }

app.post('/mcp', requireBearer, async (req, res) => {
  const sid = req.header('mcp-session-id');
  try {
    let transport;
    if (sid && sessions.has(sid)) {
      const sess = sessions.get(sid);
      if (sess.mcpToken !== req.mcpToken) {
        return res.status(403).json({ error: 'session does not belong to this token' });
      }
      transport = sess.transport;
    } else if (!sid && isInitializeRequest(req.body)) {
      const mcpToken = req.mcpToken;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newId) => { sessions.set(newId, { transport, mcpToken }); },
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      const server = buildMcpServer(mcpToken);
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

// GET = server->client SSE stream, DELETE = explicit session teardown.
async function replaySession(req, res) {
  const sid = req.header('mcp-session-id');
  const sess = sid && sessions.get(sid);
  if (!sess || sess.mcpToken !== req.mcpToken) return res.status(404).end();
  await sess.transport.handleRequest(req, res);
}
app.get('/mcp', requireBearer, replaySession);
app.delete('/mcp', requireBearer, replaySession);

app.listen(PORT, () => {
  console.log(`pingcode-mcp listening on :${PORT}`);
  console.log(`  Public URL:          ${PUBLIC_BASE_URL}`);
  console.log(`  MCP endpoint:        POST ${PUBLIC_BASE_URL}/mcp`);
  console.log(`  OAuth callback URL:  ${PUBLIC_BASE_URL}/oauth/callback`);
  console.log(`  Self-serve onboard:  ${PUBLIC_BASE_URL}/oauth/start`);
  console.log(`  (register the callback URL above in your PingCode app)`);
});
