# @zibby/skills

[![npm version](https://img.shields.io/npm/v/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![Types](https://img.shields.io/npm/types/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

[Deutsch](./i18n/README.de.md) | [Español](./i18n/README.es.md) | [français](./i18n/README.fr.md) | [日本語](./i18n/README.ja.md) | [한국어](./i18n/README.ko.md) | [Português](./i18n/README.pt.md) | [Русский](./i18n/README.ru.md) | [中文](./i18n/README.zh.md)

📖 **Full docs:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **The skill layer for [@zibby/agent-workflow](https://github.com/ZibbyDev/agent-workflow).** Built-in skill definitions that give a workflow node the tools it needs — function tools, MCP servers, browser, issue trackers, memory. Vendor-neutral, JavaScript-first.

`@zibby/skills` is the batteries-included companion to [`@zibby/agent-workflow`](https://github.com/ZibbyDev/agent-workflow) ([npm](https://www.npmjs.com/package/@zibby/agent-workflow)) — *"Graph-based AI agent workflow orchestration."* The workflow engine ships **zero skills** on purpose; this package is where the built-in ones live.

A **skill** is the contract between a workflow node and a tool. It tells the engine what the tool does, how to start it, and what it needs. The engine never hardcodes any skill by name — it reads the skill definition and wires things up generically for both Claude and Cursor agents.

```
   @zibby/agent-workflow node            @zibby/skills
   ──────────────────────────            ─────────────
   skills: ['add']            ──►        getSkill('add')
                                           │
                                           ▼
                                         skill.resolve()  →  { command, args, env }
                                           │
                                  ┌────────┴────────┐
                                  ▼                 ▼
                              Claude SDK         Cursor CLI
```

---

## Used with @zibby/agent-workflow

You don't use `@zibby/skills` on its own — it plugs into [@zibby/agent-workflow](https://github.com/ZibbyDev/agent-workflow). A node names the skills it wants in its `skills:` array, and the workflow engine resolves them at run time:

```bash
npm install @zibby/agent-workflow @zibby/skills
```

```javascript
// 1. Import the package to register all built-in skills
import '@zibby/skills';
```

Define a skill once…

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

…and an **@zibby/agent-workflow node** requests it by id:

```javascript
// Used by an @zibby/agent-workflow node
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

When the engine runs `do_math`, it sees `skills: ['add']`, looks the skill up, calls `resolve()`, and hands the resulting tool to whichever agent runs the node. See [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) for how nodes, graphs, and state fit together.

---

## Quick start

```bash
npm install @zibby/skills
```

Import the package to register all built-in skills:

```javascript
import '@zibby/skills';
```

---

## The `skill()` factory

One function to create any skill. Auto-detects the type and auto-registers.

### Function skill

One skill = one tool. Flat, no nesting.

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

Use it in an @zibby/agent-workflow node:

```javascript
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

### MCP skill

For wrapping existing MCP server packages:

```javascript
import { skill } from '@zibby/skills';

export const linear = skill('linear', {
  envKeys: ['LINEAR_API_KEY'],
  description: 'Linear issue tracker',
  resolve() {
    if (!process.env.LINEAR_API_KEY) return null;
    return {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-linear'],
      env: { LINEAR_API_KEY: process.env.LINEAR_API_KEY },
    };
  }
});
```

---

## Built-in skills

| ID | Server | MCP Package |
|----|--------|-------------|
| `browser` | `playwright` | `@zibby/mcp-browser` / `@playwright/mcp` |
| `jira` | `jira` | `@zibby/mcp-jira` |
| `github` | `github` | `@modelcontextprotocol/server-github` |
| `slack` | `slack` | `@modelcontextprotocol/server-slack` |

---

## Function skill API

```javascript
skill(id, { description, input, handler })
```

- `id` — Unique skill identifier (used in `skills: ['add']`)
- `description` — What the tool does (shown to the LLM)
- `input` — Parameter definitions:

```javascript
{
  param: { type: 'string' },             // full form
  other: 'number',                       // shorthand
  optional: { type: 'string', required: false },
}
```

- `handler` — The function that runs when the tool is called:

```javascript
handler: async ({ param, other }) => {
  return { result: 'something' };        // any JSON-serializable value
}
```

### Handler rules

- Must be `async` (or return a Promise)
- Receives one object argument with the input parameters
- Must return a JSON-serializable value
- Has full access to imports, closures, and the module scope
- Runs in a child process (the function bridge)

### More examples

```javascript
import { skill } from '@zibby/skills';

export const fetchUrl = skill('fetch_url', {
  description: 'Fetch a URL and return the response body',
  input: { url: 'string' },
  handler: async ({ url }) => {
    const res = await fetch(url);
    return { status: res.status, body: await res.text() };
  }
});

export const healthCheck = skill('health_check', {
  description: 'Check if the service is running',
  handler: async () => ({ status: 'ok', timestamp: Date.now() })
});
```

---

## MCP skill API

```javascript
skill(id, config)
```

Config object:

| Property | Required | Description |
|---|---|---|
| `resolve(options)` | Yes | Returns `{ command, args, env }` or `null` |
| `serverName` | No | MCP server name (defaults to `id`) |
| `allowedTools` | No | Tool patterns (defaults to `['mcp__<serverName>__*']`) |
| `envKeys` | No | Env vars the skill needs |
| `description` | No | Human-readable description |
| `tools` | No | Tool schemas for compile-time validation |
| `cursorKey` | No | Override key in `~/.cursor/mcp.json` |
| `sessionEnvKey` | No | Env var for session artifact paths (Cursor only) |

### Advanced example: custom binary with fallback

```javascript
import { skill } from '@zibby/skills';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

export const database = skill('database', {
  envKeys: ['DATABASE_URL'],
  description: 'Database query MCP server',
  resolve({ sessionPath } = {}) {
    let bin;
    try { bin = _require.resolve('@myorg/mcp-database/server.js'); }
    catch { bin = null; }

    if (bin) {
      return {
        command: 'node',
        args: [bin, '--read-only'],
        env: { DATABASE_URL: process.env.DATABASE_URL },
      };
    }

    return {
      command: 'npx',
      args: ['-y', '@myorg/mcp-database', '--read-only'],
      env: { DATABASE_URL: process.env.DATABASE_URL },
    };
  }
});
```

---

## How it works under the hood

```
  Node definition                Skill definition              Agent strategy
  ─────────────                  ────────────────              ──────────────
  skills: ['add']        ──►     getSkill('add')        ──►    strategy-specific setup
                                   │
                                   ▼
                                 skill.resolve()
                                   │
                                   ▼
                                 { command, args, env }
                                   │
                          ┌────────┴────────┐
                          ▼                 ▼
                      Claude SDK         Cursor CLI
                      ──────────         ──────────
                      In-memory          Writes to
                      mcpServers         ~/.cursor/mcp.json
                      param to           before spawning
                      query()            `agent` CLI
```

**Claude**: The SDK receives `mcpServers` as a parameter. It spawns the MCP server as a child process, connects via stdio, routes tool calls through it.

**Cursor**: The engine writes `~/.cursor/mcp.json` to disk before spawning the `agent` CLI. Cursor reads that file and manages MCP servers itself.

The strategies never reference any skill by name. They loop over the skill definitions and call `resolve()` on each.

---

## API

```javascript
import {
  skill,             // Unified factory — auto-detects type, auto-registers
  registerSkill,     // Register a raw skill definition
  getSkill,          // Get a skill by ID
  hasSkill,          // Check if a skill is registered
  getAllSkills,      // Get all registered skills (Map)
  listSkillIds,      // Get array of registered skill IDs
  SKILLS,            // Built-in skill ID constants
} from '@zibby/skills';
```

---

## Companion packages

| Package | What it adds |
|---|---|
| [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) | The graph engine. Skills here plug into its nodes. |
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | `zibby` command — scaffold, dev server, deploy, trigger, logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Built-in agent strategies (Claude / Cursor / Codex / Gemini / OpenAI Assistant), MCP client, runtime. |

---

## License

MIT
