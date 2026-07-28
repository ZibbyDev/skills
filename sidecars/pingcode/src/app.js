// The Express app, built as a FUNCTION of its dependencies (the PingCodeOAuth
// instance + this deployment's public URL). `src/server.js` is the thin
// entrypoint that reads env, constructs the real dependencies and listens;
// keeping the app itself injectable is what makes the OAuth flow testable
// without a live PingCode or a bound port.

import express from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';
import {
  SIDECAR_AGENT_HEADER, appConfigMiddleware, withAppConfig,
} from './app-config.js';

// Base-path awareness: when this app sits behind a reverse proxy under a
// prefix (e.g. https://host/sidecars/pingcode/... with the prefix STRIPPED
// before the request reaches us), every in-page link must carry that prefix —
// a root-relative <a href="/oauth/start"> would escape the mount. The prefix
// comes from PUBLIC_BASE_PATH, or is derived from PUBLIC_BASE_URL's path.
// Empty (direct exposure) keeps today's behaviour byte-identical.
export function normalizeBasePath(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/\/+$/, '');
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s;
}

export const STATE_TTL_MS = 10 * 60 * 1000;

// Name of the per-attempt nonce cookie. Brand-neutral on purpose.
export const NONCE_COOKIE = 'oauth_nonce';

const newMcpToken = () => 'mcp_' + randomBytes(32).toString('hex');

// Opaque, single-use, unguessable. This is the ONLY thing that links an
// /oauth/callback hit back to the /oauth/start that created it — see the long
// comment on the callback route for why "the newest pending entry" was unsafe.
const newNonce = () => randomBytes(24).toString('base64url');

// Escape text placed inside <pre>. Critical for the install prompts: they carry
// a `pingcode-<slug>` placeholder, and a raw `<slug>` is parsed as an HTML tag —
// the browser drops it, so both the visible text AND the copy button (which
// reads innerText) lose the placeholder, yielding a broken `pingcode-` command.
export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Minimal cookie reader — express 4 does not parse cookies without
// cookie-parser, and one header split is not worth a dependency (the lockfile
// is committed and reproduced byte-for-byte by `npm ci` in the image).
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

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
  .warn { background: #fff7e6; border: 1px solid #ffd591; border-radius: 8px;
          padding: 12px 16px; margin: 16px 0; font-size: 14px; }
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

export { html };

/**
 * Build the Express app.
 *
 * @param {object}  deps
 * @param {object}  deps.pc                 PingCodeOAuth (or a test double)
 * @param {string}  deps.publicBaseUrl      absolute public URL, no trailing slash
 * @param {string} [deps.basePath]          in-page link prefix (reverse proxy mount)
 * @param {boolean}[deps.callbackPathNonce] put the per-attempt nonce in the
 *        redirect_uri PATH (`/oauth/callback/<nonce>`). Off by default because
 *        PingCode validates redirect_uri against the app's registered list, so
 *        turning it on requires registering a wildcard/extra path (README).
 */
export function createApp({ pc, publicBaseUrl, basePath = '', callbackPathNonce = false }) {
  const PUBLIC_BASE_URL = String(publicBaseUrl || '').replace(/\/$/, '');
  const BASE_PATH = normalizeBasePath(basePath);

  // nonce → { mcpToken: <existing-for-renew> | null, createdAt }
  // Keyed by the per-attempt nonce, NOT by a shared counter/"newest" pointer:
  // the key IS the capability to complete that specific authorization.
  const pendingAuth = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingAuth.entries()) {
      if (now - v.createdAt > STATE_TTL_MS) pendingAuth.delete(k);
    }
  }, 60_000);
  sweeper.unref();

  // The nonce cookie must be scoped to the path the BROWSER sees (a reverse
  // proxy strips the prefix before we get the request, but the browser keeps
  // it), otherwise it is never sent back to the callback.
  const COOKIE_PATH = `${BASE_PATH}/oauth`;
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax',              // still sent on PingCode's top-level GET redirect back
    secure: PUBLIC_BASE_URL.startsWith('https://'),
    path: COOKIE_PATH,
    maxAge: STATE_TTL_MS,
  };

  // redirect_uri MUST be byte-identical on authorize and on token exchange
  // (RFC 6749 §4.1.3), so both sides derive it from the same function.
  const callbackUriFor = (nonce) =>
    callbackPathNonce
      ? `${PUBLIC_BASE_URL}/oauth/callback/${nonce}`
      : `${PUBLIC_BASE_URL}/oauth/callback`;

  const app = express();
  // PER-REQUEST TENANT CONFIG, FIRST. The control-plane injects this agent's
  // PingCode app credentials + API roots on every proxied request; this
  // middleware decodes them and runs the WHOLE request inside an
  // AsyncLocalStorage context (app-config.js), so nothing downstream needs a new
  // parameter and two agents' requests in flight cannot see each other's
  // config. With no header, every field falls back to this container's own env.
  app.use(appConfigMiddleware);
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
    res.set('Content-Type', 'text/html; charset=utf-8');
    // SNAPSHOT the app identity this attempt runs under, BEFORE the redirect.
    // The callback is a fresh request from PingCode carrying no agent hint, so
    // the identity has to ride the round-trip inside the nonce binding we
    // already keep — otherwise the code would be exchanged against whatever app
    // happened to be resolvable then, which is exactly the confusion the
    // per-tenant model exists to prevent.
    let appConfig;
    try {
      appConfig = pc.requireApp ? pc.requireApp() : (pc.app || null);
    } catch (e) {
      if (e && e.code === 'APP_NOT_CONFIGURED') {
        console.warn(`[oauth] start refused: ${e.message}`);
        return res.status(503).send(html(`
          <h2 class="err">⚠️ 这个部署还没有配置 PingCode 应用</h2>
          <p>缺少: <code>${esc((e.missing || []).join(', '))}</code></p>
          <p>请在<strong>声明了本 sidecar 的 agent 的 Env 标签页</strong>里填好这些值
          (它们会在每次请求时从该 agent 的加密环境中读取), 然后重新点授权链接。</p>
        `));
      }
      throw e;
    }
    const renewToken = req.query.renew ? String(req.query.renew) : null;
    if (renewToken) {
      const slot = pc.slotFor ? await pc.slotFor(renewToken) : { ok: await pc.hasSlot(renewToken) };
      if (!slot.ok) {
        // 'other_app' is a DIFFERENT failure from 'unknown' and says so: the
        // token is real, it just belongs to another PingCode app.
        const otherApp = slot.reason === 'other_app';
        return res.status(400).send(html(otherApp ? `
        <h2 class="err">⚠️ 这个 MCP_TOKEN 属于另一个 PingCode 应用</h2>
        <p>它是用别的 OAuth 应用 (client_id) 授权出来的, 不能在当前应用下续签。
        请用当初那个应用对应的入口续签, 或走<a href="${BASE_PATH}/oauth/start">新用户授权</a>重新生成。</p>
      ` : `
        <h2 class="err">⚠️ 找不到这个 MCP_TOKEN</h2>
        <p>你提供的 renew 值不存在或已被吊销。请走<a href="${BASE_PATH}/oauth/start">新用户授权</a>重新生成一个。</p>
      `));
      }
    }
    const nonce = newNonce();
    // `app` is the per-attempt app identity: the callback exchanges the code
    // against THIS config, never against whatever is ambient at callback time.
    pendingAuth.set(nonce, {
      mcpToken: renewToken,
      createdAt: Date.now(),
      app: appConfig,
      agent: req.header(SIDECAR_AGENT_HEADER) || '',
    });
    // Belt: the nonce rides back in a cookie (works with the plain, already
    // registered redirect URI). Braces: optionally also in the redirect_uri
    // path, for deployments whose PingCode app allows the extra segment.
    res.cookie(NONCE_COOKIE, nonce, cookieOpts);
    // `state` carries the same value: harmless if PingCode drops it (it does),
    // and a free extra corroboration if any instance ever echoes it back.
    res.redirect(302, pc.authorizeUrl(nonce, { redirectUri: callbackUriFor(nonce) }));
  });

  // ─── OAuth: callback ─────────────────────────────────────────────
  // PingCode redirects the user here after consent. MUST match the redirect
  // URI configured in the PingCode app.
  //
  // SECURITY — why this is nonce-keyed and not "the newest pending entry":
  // PingCode does not echo `state`, so the original code correlated a callback
  // with whichever /oauth/start happened most recently. That is a confused
  // deputy: an attacker who completes THEIR OWN PingCode authorization while a
  // victim's renew is pending lands the ATTACKER's tokens in the VICTIM's slot,
  // and the victim's agent then operates the attacker's PingCode account. The
  // callback now must PRESENT the nonce minted at /oauth/start (path segment
  // and/or cookie and/or state). No nonce, an unknown nonce, or two sources
  // that disagree ⇒ refuse. There is no fallback.
  async function handleCallback(req, res) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    const code = String(req.query.code || '');
    if (!code) {
      return res.status(400).send(html(`<h2 class="err">Missing authorization code</h2>`));
    }

    // Collect every nonce the request presents; they must all agree.
    const seen = new Set();
    if (req.params && req.params.nonce) seen.add(String(req.params.nonce));
    const cookieNonce = parseCookies(req.headers.cookie)[NONCE_COOKIE];
    if (cookieNonce) seen.add(cookieNonce);
    if (req.query.state) seen.add(String(req.query.state));

    const restart = `<p>请回到 <a href="${BASE_PATH}/oauth/start">授权入口</a> 重新开始(同一个浏览器里完成整个流程)。</p>`;
    if (seen.size === 0) {
      console.warn('[oauth] callback refused: no nonce presented (cookie/path/state all absent)');
      return res.status(400).send(html(`
        <h2 class="err">⚠️ 授权请求无法校验</h2>
        <p>这次回调没有带上发起授权时生成的一次性凭据(nonce),无法确认它属于哪次授权,已拒绝。</p>
        <p class="muted">常见原因:浏览器禁用了 Cookie、换了浏览器/设备完成授权,或链接放置超过 10 分钟已过期。</p>
        ${restart}`));
    }
    if (seen.size > 1) {
      console.warn('[oauth] callback refused: conflicting nonces presented');
      return res.status(400).send(html(`
        <h2 class="err">⚠️ 授权请求无法校验</h2>
        <p>这次回调带了多个互相矛盾的一次性凭据(例如同时开了两个授权页面),无法确定属于哪一次,已拒绝。</p>
        ${restart}`));
    }
    const nonce = [...seen][0];
    const entry = pendingAuth.get(nonce);
    if (!entry) {
      // Unknown / already-used / expired. Deliberately NOT consumed and NOT
      // guessed at — this is the branch that used to fall back to "newest".
      console.warn('[oauth] callback refused: nonce did not match any pending authorization');
      return res.status(400).send(html(`
        <h2 class="err">⚠️ 授权请求已失效</h2>
        <p>这次回调对应的授权请求不存在、已被使用过,或已超过 10 分钟有效期,已拒绝。</p>
        ${restart}`));
    }
    // Matched exactly one pending entry → consume it (single use).
    pendingAuth.delete(nonce);
    res.clearCookie(NONCE_COOKIE, { path: COOKIE_PATH });

    // THE ROUND-TRIP BINDING. Everything below runs under the app identity that
    // was captured at /oauth/start and carried on this nonce's pending entry —
    // NOT under whatever config happens to be ambient on this callback request
    // (PingCode's redirect carries no agent hint, so there may be none at all).
    // That is what guarantees the code is exchanged against the SAME client_id
    // that requested it, and that the resulting slot is stamped with that app.
    return withAppConfig(entry.app, async () => {
      try {
        const tokens = await pc.exchangeCode(code, { redirectUri: callbackUriFor(nonce) });

        // Who just authorized? Identity is the second, independent guard: even if
        // a nonce leaks (it travels in a URL / browser history), a renew may only
        // ever be completed by the SAME PingCode user the slot already belongs to.
        const identity = await pc.fetchIdentity(tokens.access_token);
        const userId = identity && identity.userId ? String(identity.userId) : null;

        if (entry.mcpToken) {
          // ── renew flow: update existing slot, keep MCP_TOKEN unchanged ──
          //
          // FAIL CLOSED. If we cannot establish who just consented, we refuse —
          // for a bound slot AND for a legacy/unbound one. The previous code
          // skipped the check when `pingcode_user_id` was absent, which made the
          // whole identity guard a no-op in the default configuration (an empty
          // PINGCODE_SCOPE makes GET /v1/myself 403 → userId null → check
          // skipped) and left the slot overwritable by whoever raced the callback.
          if (!userId) {
            console.warn(
              `[oauth] renew REFUSED for slot ${String(entry.mcpToken).slice(0, 12)}…: ` +
              `PingCode identity could not be established (${identity?.error || 'unknown error'}) — ` +
              'nothing was written',
            );
            return res.status(403).send(html(`
              <h2 class="err">⚠️ 续签被拒绝:无法确认授权者身份</h2>
              <p>服务器无法通过 <code>GET /v1/myself</code> 确认刚才授权的是哪个 PingCode 账号,
              因此拒绝把令牌写入这个 MCP_TOKEN(宁可拒绝,也不能把别人的令牌写进你的槽位)。
              <strong>你的原有授权没有被改动。</strong></p>
              <p class="muted">管理员请检查:PingCode 应用的授权范围 <code>PINGCODE_SCOPE</code>
              必须覆盖 <code>GET /v1/myself</code>(当前应用对该接口无权限或未配置 scope,
              返回:${esc(identity?.error || 'unknown error')})。修好后请用户重新点续签链接。</p>
              ${restart}`));
          }

          const existing = (await pc.store.get(entry.mcpToken)) || {};
          const boundId = existing.pingcode_user_id ? String(existing.pingcode_user_id) : null;
          if (boundId && userId !== boundId) {
            console.warn(
              `[oauth] renew REFUSED for slot ${String(entry.mcpToken).slice(0, 12)}…: ` +
              'consenting PingCode user differs from the bound one — nothing was written',
            );
            return res.status(403).send(html(`
              <h2 class="err">⚠️ 续签被拒绝:账号不一致</h2>
              <p>这个 renew 链接属于另一个 PingCode 账号。请用当初授权这个 MCP_TOKEN 的
              PingCode 账号登录后重试;或者走<a href="${BASE_PATH}/oauth/start">新用户授权</a>生成自己的 MCP_TOKEN。</p>
            `));
          }
          // Legacy slot with no recorded identity (pre-migration): bind it now —
          // safe because reaching here required the nonce from THIS slot's own
          // /oauth/start AND a resolvable identity.
          await pc.saveTokens(entry.mcpToken, {
            ...existing,
            ...tokens,
            pingcode_user_id: boundId || userId,
          });
          return res.send(html(`
            <h2 class="ok">✅ PingCode 重新授权完成</h2>
            <p>你的 MCP_TOKEN <strong>没变</strong>，Claude Code 配置不用动。</p>
            <p>直接回到对话, 让 agent 重试刚才那个工具调用就行。</p>
            <p class="muted">下次过期大约在 90 天后。</p>
          `));
        }

        // ── first-time flow: mint a fresh MCP_TOKEN ──
        // No slot exists yet, so there is nothing to hijack: a missing identity
        // here cannot hand anyone else's tokens to anyone. We therefore still
        // issue the token (a deployment whose scope omits /v1/myself but covers
        // the business endpoints keeps working) — but we say LOUDLY that the slot
        // is unbindable, because every future renew WILL be refused above.
        const mcpToken = newMcpToken();
        await pc.saveTokens(mcpToken, {
          ...tokens,
          created_at: Date.now(),
          // Remember whose slot this is, so future renews can be identity-bound.
          pingcode_user_id: userId,
        });
        if (!userId) {
          console.warn(
            '[oauth] new slot created WITHOUT a PingCode identity ' +
            `(${identity?.error || 'unknown error'}) — renews for it will be refused. ` +
            'Grant the OAuth app access to GET /v1/myself and set PINGCODE_SCOPE.',
          );
        }

        // Two SEPARATE copy-paste prompts, one per agent. Each is a self-contained
        // natural-language prompt: paste it to the agent and it installs itself, no
        // hand-typed commands. Codex has no `add` for HTTP servers, so its prompt
        // carries a config.toml block; Codex sends http_headers verbatim, so a
        // static Authorization header authenticates like Claude's --header. Each
        // block gets a top-right copy button (copyBlock in the page script).
        // The endpoint the user's editor will call. On a box where SEVERAL agents
      // declare this sidecar, a bare /mcp cannot tell the control-plane whose
      // config to inject — so carry the agent handle the proxy told us about.
      // With 0 or 1 declaring agents the header is absent and the URL is
      // byte-identical to before.
      const agentQs = entry.agent ? `?agent=${encodeURIComponent(entry.agent)}` : '';
      const mcpUrl = `${PUBLIC_BASE_URL}/mcp${agentQs}`;
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
        const identityWarning = userId ? '' : `
          <div class="warn">
            ⚠️ <strong>这个授权没有绑定 PingCode 身份。</strong>
            服务器无法通过 <code>GET /v1/myself</code> 确认你的账号
            (${esc(identity?.error || 'unknown error')}),因此 90 天后的<strong>续签会被拒绝</strong>,
            届时需要重新走一次授权并更新配置。请让管理员为 OAuth 应用开通 <code>/v1/myself</code>
            权限并设置 <code>PINGCODE_SCOPE</code>,然后重新授权一次即可一劳永逸。
          </div>`;
        return res.send(html(`
          <h2 class="ok">✅ PingCode 授权成功</h2>
          ${identityWarning}
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
  }

  // Both shapes are served: the plain path (nonce arrives by cookie/state) and
  // the per-attempt path segment. Which one PingCode redirects to is decided by
  // the redirect_uri we sent at /oauth/start (callbackPathNonce).
  app.get('/oauth/callback', handleCallback);
  app.get('/oauth/callback/:nonce', handleCallback);

  // ─── MCP: Streamable HTTP transport ──────────────────────────────
  // Sessions must persist across requests: the client sends `initialize`
  // first (no session id) and the server returns a Mcp-Session-Id header;
  // every later request (tools/list, tools/call, ...) carries that header.
  // We key live transports by session id. Each session is bound to the
  // mcpToken that created it, so a session always acts as that one user.
  const sessions = new Map(); // sessionId -> { transport, mcpToken }

  // The bearer identifies a SLOT, and a slot is keyed by (USER, APP) — a token
  // minted under PingCode app A is meaningless under app B (PingCode itself will
  // not refresh it), so serving it would be a silent cross-tenant reach. The
  // mismatch is REFUSED with its own status + message, never conflated with
  // "unknown token".
  async function requireBearer(req, res, next) {
    const auth = req.header('authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'missing bearer token' });
    const slot = pc.slotFor ? await pc.slotFor(m[1]) : { ok: await pc.hasSlot(m[1]) };
    if (!slot.ok) {
      if (slot.reason === 'other_app') {
        return res.status(403).json({
          error: 'mcp_token belongs to a different PingCode app',
          authorize_url: `${PUBLIC_BASE_URL}/oauth/start`,
        });
      }
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

  // Exposed for tests/diagnostics; not a route.
  app.locals.pendingAuth = pendingAuth;
  return app;
}
