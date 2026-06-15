# @zibby/skills — 中文

[![npm version](https://img.shields.io/npm/v/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![Types](https://img.shields.io/npm/types/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [français](./README.fr.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

📖 **完整文档：** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **[@zibby/agent-workflow](https://github.com/ZibbyDev/agent-workflow) 的技能层。** 内置的技能定义，为工作流节点提供它所需的工具——函数工具、MCP 服务器、浏览器、问题追踪器、记忆。供应商中立，JavaScript 优先。

`@zibby/skills` 是 [`@zibby/agent-workflow`](https://github.com/ZibbyDev/agent-workflow)（[npm](https://www.npmjs.com/package/@zibby/agent-workflow)）开箱即用的配套包——*“Graph-based AI agent workflow orchestration.”* 工作流引擎刻意**不附带任何技能**；内置技能就存放在本包中。

**技能（skill）**是工作流节点与工具之间的契约。它告诉引擎这个工具做什么、如何启动、需要什么。引擎从不按名称硬编码任何技能——它读取技能定义，并以通用方式为 Claude 和 Cursor 两类代理完成接线。

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

## 与 @zibby/agent-workflow 配合使用

你不会单独使用 `@zibby/skills`——它接入 [@zibby/agent-workflow](https://github.com/ZibbyDev/agent-workflow)。节点在其 `skills:` 数组中声明所需的技能，工作流引擎会在运行时解析它们：

```bash
npm install @zibby/agent-workflow @zibby/skills
```

```javascript
// 1. Import the package to register all built-in skills
import '@zibby/skills';
```

定义一次技能……

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

……然后一个 **@zibby/agent-workflow 节点**通过 id 请求它：

```javascript
// Used by an @zibby/agent-workflow node
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

当引擎运行 `do_math` 时，它看到 `skills: ['add']`，查找该技能，调用 `resolve()`，并把得到的工具交给运行该节点的代理。关于节点、图和状态如何协同，参见 [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow)。

---

## 快速开始

```bash
npm install @zibby/skills
```

导入该包以注册所有内置技能：

```javascript
import '@zibby/skills';
```

---

## `skill()` 工厂函数

一个函数即可创建任意技能。自动检测类型并自动注册。

### 函数技能

一个技能 = 一个工具。扁平，无嵌套。

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

在 @zibby/agent-workflow 节点中使用：

```javascript
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

### MCP 技能

用于包装现有的 MCP 服务器包：

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

## 内置技能

| ID | 服务器 | MCP 包 |
|----|--------|-------------|
| `browser` | `playwright` | `@zibby/mcp-browser` / `@playwright/mcp` |
| `jira` | `jira` | `@zibby/mcp-jira` |
| `github` | `github` | `@modelcontextprotocol/server-github` |
| `slack` | `slack` | `@modelcontextprotocol/server-slack` |

---

## 函数技能 API

```javascript
skill(id, { description, input, handler })
```

- `id` — 唯一的技能标识符（在 `skills: ['add']` 中使用）
- `description` — 工具的功能（展示给 LLM）
- `input` — 参数定义：

```javascript
{
  param: { type: 'string' },             // full form
  other: 'number',                       // shorthand
  optional: { type: 'string', required: false },
}
```

- `handler` — 工具被调用时运行的函数：

```javascript
handler: async ({ param, other }) => {
  return { result: 'something' };        // any JSON-serializable value
}
```

### handler 规则

- 必须是 `async`（或返回 Promise）
- 接收一个包含输入参数的对象参数
- 必须返回可 JSON 序列化的值
- 可完全访问导入、闭包和模块作用域
- 在子进程（函数桥）中运行

### 更多示例

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

## MCP 技能 API

```javascript
skill(id, config)
```

配置对象：

| 属性 | 必填 | 描述 |
|---|---|---|
| `resolve(options)` | 是 | 返回 `{ command, args, env }` 或 `null` |
| `serverName` | 否 | MCP 服务器名称（默认为 `id`） |
| `allowedTools` | 否 | 工具模式（默认为 `['mcp__<serverName>__*']`） |
| `envKeys` | 否 | 技能所需的环境变量 |
| `description` | 否 | 人类可读的描述 |
| `tools` | 否 | 用于编译期校验的工具 schema |
| `cursorKey` | 否 | 覆盖 `~/.cursor/mcp.json` 中的键 |
| `sessionEnvKey` | 否 | 用于会话产物路径的环境变量（仅 Cursor） |

### 进阶示例：带回退的自定义二进制

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

## 底层工作原理

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

**Claude**：SDK 以参数形式接收 `mcpServers`。它将 MCP 服务器作为子进程启动，通过 stdio 连接，并将工具调用经由它路由。

**Cursor**：引擎在启动 `agent` CLI 之前，将 `~/.cursor/mcp.json` 写入磁盘。Cursor 读取该文件并自行管理 MCP 服务器。

各策略从不按名称引用任何技能。它们遍历技能定义，并对每一个调用 `resolve()`。

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

## 配套包

| 包 | 它提供什么 |
|---|---|
| [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) | 图引擎。本包中的技能接入它的节点。 |
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | `zibby` 命令——脚手架、开发服务器、deploy、trigger、logs。 |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | 内置代理策略（Claude / Cursor / Codex / Gemini / OpenAI Assistant）、MCP 客户端、运行时。 |

---

## 许可证

MIT
