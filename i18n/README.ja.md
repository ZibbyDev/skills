# @zibby/skills — 日本語

[![npm version](https://img.shields.io/npm/v/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![Types](https://img.shields.io/npm/types/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [français](./README.fr.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **完全なドキュメント:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **[@zibby/agent-workflow](https://github.com/ZibbyDev/agent-workflow) のためのスキル層。** ワークフローノードに必要なツール（関数ツール、MCP サーバー、ブラウザ、課題トラッカー、メモリ）を与える組み込みのスキル定義です。ベンダー中立、JavaScript ファースト。

`@zibby/skills` は [`@zibby/agent-workflow`](https://github.com/ZibbyDev/agent-workflow)（[npm](https://www.npmjs.com/package/@zibby/agent-workflow)）の充実した付属パッケージです — *「Graph-based AI agent workflow orchestration.」* ワークフローエンジンは意図的に**スキルをひとつも同梱しません**。このパッケージこそが組み込みスキルの置き場所です。

**スキル**はワークフローノードとツールの間の契約です。そのツールが何をするのか、どう起動するのか、何を必要とするのかをエンジンに伝えます。エンジンがスキルを名前でハードコードすることは決してありません。スキル定義を読み取り、Claude エージェントと Cursor エージェントの両方に対して汎用的に配線します。

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

## @zibby/agent-workflow と併用する

`@zibby/skills` を単体で使うことはありません。[@zibby/agent-workflow](https://github.com/ZibbyDev/agent-workflow) に組み込んで使います。ノードは `skills:` 配列で必要なスキルを指定し、ワークフローエンジンが実行時にそれらを解決します。

```bash
npm install @zibby/agent-workflow @zibby/skills
```

```javascript
// 1. Import the package to register all built-in skills
import '@zibby/skills';
```

スキルを一度定義し…

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

…**@zibby/agent-workflow ノード**が id で要求します。

```javascript
// Used by an @zibby/agent-workflow node
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

エンジンが `do_math` を実行すると、`skills: ['add']` を見て、スキルを検索し、`resolve()` を呼び出し、得られたツールをノードを実行するエージェントに渡します。ノード、グラフ、状態がどのように組み合わさるかは [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) を参照してください。

---

## クイックスタート

```bash
npm install @zibby/skills
```

パッケージをインポートして、すべての組み込みスキルを登録します。

```javascript
import '@zibby/skills';
```

---

## `skill()` ファクトリ

任意のスキルを作成する 1 つの関数。型を自動検出し、自動登録します。

### 関数スキル

1 スキル = 1 ツール。フラットでネストなし。

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

@zibby/agent-workflow ノードで使います。

```javascript
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

### MCP スキル

既存の MCP サーバーパッケージをラップする場合:

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

## 組み込みスキル

| ID | サーバー | MCP パッケージ |
|----|--------|-------------|
| `browser` | `playwright` | `@zibby/mcp-browser` / `@playwright/mcp` |
| `jira` | `jira` | `@zibby/mcp-jira` |
| `github` | `github` | `@modelcontextprotocol/server-github` |
| `slack` | `slack` | `@modelcontextprotocol/server-slack` |

---

## 関数スキル API

```javascript
skill(id, { description, input, handler })
```

- `id` — 一意のスキル識別子（`skills: ['add']` で使用）
- `description` — ツールが行うこと（LLM に表示される）
- `input` — パラメータ定義:

```javascript
{
  param: { type: 'string' },             // full form
  other: 'number',                       // shorthand
  optional: { type: 'string', required: false },
}
```

- `handler` — ツールが呼び出されたときに実行される関数:

```javascript
handler: async ({ param, other }) => {
  return { result: 'something' };        // any JSON-serializable value
}
```

### ハンドラのルール

- `async` であること（または Promise を返すこと）
- 入力パラメータを含む 1 つのオブジェクト引数を受け取る
- JSON シリアライズ可能な値を返すこと
- import、クロージャ、モジュールスコープに完全にアクセスできる
- 子プロセス（関数ブリッジ）で実行される

### その他の例

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

## MCP スキル API

```javascript
skill(id, config)
```

設定オブジェクト:

| プロパティ | 必須 | 説明 |
|---|---|---|
| `resolve(options)` | はい | `{ command, args, env }` または `null` を返す |
| `serverName` | いいえ | MCP サーバー名（デフォルトは `id`） |
| `allowedTools` | いいえ | ツールパターン（デフォルトは `['mcp__<serverName>__*']`） |
| `envKeys` | いいえ | スキルが必要とする環境変数 |
| `description` | いいえ | 人間が読める説明 |
| `tools` | いいえ | コンパイル時検証のためのツールスキーマ |
| `cursorKey` | いいえ | `~/.cursor/mcp.json` のキーを上書き |
| `sessionEnvKey` | いいえ | セッション成果物パス用の環境変数（Cursor のみ） |

### 高度な例: フォールバック付きのカスタムバイナリ

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

## 内部の仕組み

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

**Claude**: SDK は `mcpServers` をパラメータとして受け取ります。MCP サーバーを子プロセスとして起動し、stdio 経由で接続し、ツール呼び出しをそこ経由でルーティングします。

**Cursor**: エンジンは `agent` CLI を起動する前に `~/.cursor/mcp.json` をディスクに書き込みます。Cursor はそのファイルを読み取り、MCP サーバーを自身で管理します。

ストラテジーがスキルを名前で参照することは決してありません。スキル定義をループし、それぞれに対して `resolve()` を呼び出します。

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

## コンパニオンパッケージ

| パッケージ | 追加する機能 |
|---|---|
| [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) | グラフエンジン。ここのスキルはそのノードに組み込まれます。 |
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | `zibby` コマンド — scaffold、開発サーバー、deploy、trigger、logs。 |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | 組み込みエージェントストラテジー（Claude / Cursor / Codex / Gemini / OpenAI Assistant）、MCP クライアント、ランタイム。 |

---

## ライセンス

MIT
