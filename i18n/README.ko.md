# @zibby/skills — 한국어

[![npm version](https://img.shields.io/npm/v/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![Types](https://img.shields.io/npm/types/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [français](./README.fr.md) | [日本語](./README.ja.md) | [Português](./README.pt.md) | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **전체 문서:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **[@zibby/agent-workflow](https://github.com/ZibbyHQ/agent-workflow)를 위한 스킬 레이어.** 워크플로 노드에 필요한 도구(함수 도구, MCP 서버, 브라우저, 이슈 트래커, 메모리)를 제공하는 내장 스킬 정의입니다. 벤더 중립적이며 JavaScript 우선.

`@zibby/skills`는 [`@zibby/agent-workflow`](https://github.com/ZibbyHQ/agent-workflow)([npm](https://www.npmjs.com/package/@zibby/agent-workflow))의 모든 기능이 포함된 동반 패키지입니다 — *"Graph-based AI agent workflow orchestration."* 워크플로 엔진은 의도적으로 **스킬을 하나도 제공하지 않습니다**. 이 패키지가 바로 내장 스킬이 사는 곳입니다.

**스킬**은 워크플로 노드와 도구 사이의 계약입니다. 도구가 무엇을 하는지, 어떻게 시작하는지, 무엇이 필요한지를 엔진에 알려줍니다. 엔진은 스킬을 이름으로 하드코딩하지 않습니다. 스킬 정의를 읽어 Claude 및 Cursor 에이전트 모두에 대해 일반적인 방식으로 연결합니다.

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

## @zibby/agent-workflow와 함께 사용하기

`@zibby/skills`는 단독으로 사용하지 않습니다. [@zibby/agent-workflow](https://github.com/ZibbyHQ/agent-workflow)에 연결됩니다. 노드는 `skills:` 배열에 원하는 스킬을 지정하고, 워크플로 엔진이 실행 시점에 이를 해석합니다.

```bash
npm install @zibby/agent-workflow @zibby/skills
```

```javascript
// 1. Import the package to register all built-in skills
import '@zibby/skills';
```

스킬을 한 번 정의하면…

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

…**@zibby/agent-workflow 노드**가 id로 요청합니다.

```javascript
// Used by an @zibby/agent-workflow node
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

엔진이 `do_math`를 실행하면 `skills: ['add']`를 확인하고 스킬을 조회한 뒤 `resolve()`를 호출하고, 그 결과 도구를 노드를 실행하는 에이전트에 전달합니다. 노드, 그래프, 상태가 어떻게 맞물리는지는 [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow)를 참고하세요.

---

## 빠른 시작

```bash
npm install @zibby/skills
```

패키지를 import하여 모든 내장 스킬을 등록합니다.

```javascript
import '@zibby/skills';
```

---

## `skill()` 팩토리

모든 스킬을 만드는 하나의 함수입니다. 유형을 자동 감지하고 자동 등록합니다.

### 함수 스킬

스킬 1개 = 도구 1개. 평면적이며 중첩 없음.

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

@zibby/agent-workflow 노드에서 사용합니다.

```javascript
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

### MCP 스킬

기존 MCP 서버 패키지를 래핑할 때:

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

## 내장 스킬

| ID | 서버 | MCP 패키지 |
|----|--------|-------------|
| `browser` | `playwright` | `@zibby/mcp-browser` / `@playwright/mcp` |
| `jira` | `jira` | `@zibby/mcp-jira` |
| `github` | `github` | `@modelcontextprotocol/server-github` |
| `slack` | `slack` | `@modelcontextprotocol/server-slack` |

---

## 함수 스킬 API

```javascript
skill(id, { description, input, handler })
```

- `id` — 고유 스킬 식별자(`skills: ['add']`에서 사용)
- `description` — 도구가 하는 일(LLM에 표시됨)
- `input` — 매개변수 정의:

```javascript
{
  param: { type: 'string' },             // full form
  other: 'number',                       // shorthand
  optional: { type: 'string', required: false },
}
```

- `handler` — 도구가 호출될 때 실행되는 함수:

```javascript
handler: async ({ param, other }) => {
  return { result: 'something' };        // any JSON-serializable value
}
```

### 핸들러 규칙

- `async`여야 함(또는 Promise를 반환)
- 입력 매개변수가 담긴 객체 인수 하나를 받음
- JSON 직렬화 가능한 값을 반환해야 함
- import, 클로저, 모듈 스코프에 완전히 접근 가능
- 자식 프로세스(함수 브리지)에서 실행됨

### 추가 예제

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

## MCP 스킬 API

```javascript
skill(id, config)
```

구성 객체:

| 속성 | 필수 | 설명 |
|---|---|---|
| `resolve(options)` | 예 | `{ command, args, env }` 또는 `null`을 반환 |
| `serverName` | 아니오 | MCP 서버 이름(기본값 `id`) |
| `allowedTools` | 아니오 | 도구 패턴(기본값 `['mcp__<serverName>__*']`) |
| `envKeys` | 아니오 | 스킬이 필요로 하는 환경 변수 |
| `description` | 아니오 | 사람이 읽을 수 있는 설명 |
| `tools` | 아니오 | 컴파일 타임 검증을 위한 도구 스키마 |
| `cursorKey` | 아니오 | `~/.cursor/mcp.json`의 키를 재정의 |
| `sessionEnvKey` | 아니오 | 세션 아티팩트 경로용 환경 변수(Cursor 전용) |

### 고급 예제: 폴백이 있는 커스텀 바이너리

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

## 내부 동작 방식

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

**Claude**: SDK는 `mcpServers`를 매개변수로 받습니다. MCP 서버를 자식 프로세스로 시작하고 stdio를 통해 연결한 뒤, 도구 호출을 그를 통해 라우팅합니다.

**Cursor**: 엔진은 `agent` CLI를 시작하기 전에 `~/.cursor/mcp.json`을 디스크에 씁니다. Cursor는 그 파일을 읽고 MCP 서버를 직접 관리합니다.

스트래티지는 스킬을 이름으로 참조하지 않습니다. 스킬 정의를 순회하며 각각에 대해 `resolve()`를 호출합니다.

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

## 동반 패키지

| 패키지 | 추가하는 기능 |
|---|---|
| [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) | 그래프 엔진. 여기의 스킬은 그 노드에 연결됩니다. |
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | `zibby` 명령 — scaffold, 개발 서버, deploy, trigger, logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | 내장 에이전트 스트래티지(Claude / Cursor / Codex / Gemini / OpenAI Assistant), MCP 클라이언트, 런타임. |

---

## 라이선스

MIT
