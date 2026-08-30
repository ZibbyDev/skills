# MCP tool loading — why no skill declares `alwaysLoad`

**Decision (2026-08-30): no skill in this package forces its tools into the
system prompt. They are deferred behind ToolSearch, which is the SDK's default
and, measured, works.**

## What `alwaysLoad` did

`@anthropic-ai/claude-agent-sdk`, `sdk.d.ts`:

> `alwaysLoad?: boolean` — When true, all tools from this server are always
> included in the prompt and never deferred behind tool search. Equivalent to
> setting `defer_loading: false` on the API. **Default: tools are deferred when
> tool search is enabled.** As a side effect this also blocks startup until the
> server is connected (capped at the standard 5s connect timeout) … since the
> tools must be present when the turn-1 prompt is built.

Twenty-six skills declared it. That put **158 tool schemas into every system
prompt of every claude agent, on every turn**, whether or not the turn had
anything to do with those providers:

```
 28 github   12 vikunja    9 linear     7 notion    5 sentry        3 kv-memory
 18 gitlab   12 slack      9 hubspot    6 lark      5 artifact      3 code-stats
                12 figma      8 lark-docs  6 lark-attendance  5 google-docs  3 gbrain
                                                              2 discord   1 ×5 others
```

For comparison, `@zibby/skills-internal`'s control-plane skill — **86 tools** —
declares `alwaysLoad: false` on purpose, with a tripwire pinning it. The line
was drawn at "big servers defer, small ones don't", and the small ones added up
to nearly twice the big one.

## The belief it rested on, and why it was wrong

`sentry.ts` carried the original justification: *"the LLM's
`ToolSearch({"query":"sentry"})` returns nothing for MCP-served tools even when
the server is connected — we verified this against Fargate logs."* Every later
skill copied it.

That observation had a simpler explanation. A skill whose `resolve()` returns
`null` registers **no MCP server at all** (`tool-resolver.ts`: `if (resolved)`),
and a server that was never registered returns nothing to ToolSearch — which is
indistinguishable, from the log, from a ToolSearch that cannot see MCP tools.
The jira skill sat in exactly that state for months (it spawned
`@zibby/mcp-jira`, a package that does not exist), and produced the same
symptom.

## The measurement

Self-host Copilot, jira fixed and deliberately **without** `alwaysLoad`
(`zibby-copilot-runtime`, 2026-08-30). Prompt: *"Search Jira project KAN and
list the issue keys + summaries."*

```
[mcp] SDK init — 10 server(s): … jira=connected
                111 DEFERRED behind ToolSearch [cp:71  mcp_79ef9c5c:26  jira:14]
◆ ToolSearch {"query":"select:mcp__jira__jira_search,mcp__jira__jira_list_projects,…"}
◆ mcp__jira__jira_search  {"jql":"project = KAN ORDER BY updated DESC"}  ok:true
```

The model found the deferred MCP tools by name and called one. ToolSearch
reaches MCP-served tools. The premise for `alwaysLoad` does not hold.

## Scope — this is a claude-only knob

`@zibby/core` `mcp-server-config.js`: `ALWAYS_LOAD_VENDORS = new Set(['claude'])`.
codex, gemini and cursor never receive the flag and have no deferral concept —
they load every MCP tool eagerly regardless. So removing the declarations
changes **nothing** for them, and the fact that (e.g.) gemini has no ToolSearch
is not a reason to keep it.

## What is kept

- The `alwaysLoad` **plumbing** in `mcp-server-config.js` (pass-through, the
  `MCP_ALWAYS_LOAD=0` escape hatch, the tripwire test). The mechanism is sound;
  it is the blanket use of it that was not.
- `chat_send` (selfhosted copilot, **1 tool**) still declares it. That one has a
  measured benefit of its own: it is the tool the model needs to say anything at
  all, and deferring it spends a whole ToolSearch round-trip before the first
  word of a reply.

## The rule going forward

Default to deferral. `alwaysLoad` is justified only by a measurement on a
specific tool — "the model needs this before it can act at all" — never by
"my provider is important".
