# @zibby/skills — Русский

[![npm version](https://img.shields.io/npm/v/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![Types](https://img.shields.io/npm/types/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [français](./README.fr.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | [中文](./README.zh.md)

📖 **Полная документация:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **Слой навыков для [@zibby/agent-workflow](https://github.com/ZibbyDev/agent-workflow).** Встроенные определения навыков, которые дают узлу workflow нужные инструменты — функциональные инструменты, серверы MCP, браузер, трекеры задач, память. Независимость от поставщика, JavaScript в первую очередь.

`@zibby/skills` — это укомплектованный спутник [`@zibby/agent-workflow`](https://github.com/ZibbyDev/agent-workflow) ([npm](https://www.npmjs.com/package/@zibby/agent-workflow)) — *«Graph-based AI agent workflow orchestration.»* Движок workflow намеренно поставляется **без единого навыка**; именно в этом пакете живут встроенные.

**Навык** — это контракт между узлом workflow и инструментом. Он сообщает движку, что делает инструмент, как его запустить и что ему нужно. Движок никогда не прописывает навык по имени — он читает определение навыка и подключает всё универсально, как для агентов Claude, так и для Cursor.

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

## Использование с @zibby/agent-workflow

Вы не используете `@zibby/skills` сам по себе — он подключается к [@zibby/agent-workflow](https://github.com/ZibbyDev/agent-workflow). Узел указывает нужные навыки в своём массиве `skills:`, а движок workflow разрешает их во время выполнения:

```bash
npm install @zibby/agent-workflow @zibby/skills
```

```javascript
// 1. Import the package to register all built-in skills
import '@zibby/skills';
```

Определите навык один раз…

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

…и **узел @zibby/agent-workflow** запрашивает его по id:

```javascript
// Used by an @zibby/agent-workflow node
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

Когда движок выполняет `do_math`, он видит `skills: ['add']`, находит навык, вызывает `resolve()` и передаёт полученный инструмент тому агенту, который выполняет узел. См. [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow), чтобы понять, как сочетаются узлы, графы и состояние.

---

## Быстрый старт

```bash
npm install @zibby/skills
```

Импортируйте пакет, чтобы зарегистрировать все встроенные навыки:

```javascript
import '@zibby/skills';
```

---

## Фабрика `skill()`

Одна функция для создания любого навыка. Автоматически определяет тип и автоматически регистрирует.

### Функциональный навык

Один навык = один инструмент. Плоский, без вложенности.

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

Используйте его в узле @zibby/agent-workflow:

```javascript
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

### Навык MCP

Для обёртки существующих пакетов серверов MCP:

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

## Встроенные навыки

| ID | Сервер | Пакет MCP |
|----|--------|-------------|
| `browser` | `playwright` | `@zibby/mcp-browser` / `@playwright/mcp` |
| `jira` | `jira` | `@zibby/mcp-jira` |
| `github` | `github` | `@modelcontextprotocol/server-github` |
| `slack` | `slack` | `@modelcontextprotocol/server-slack` |

---

## API функционального навыка

```javascript
skill(id, { description, input, handler })
```

- `id` — Уникальный идентификатор навыка (используется в `skills: ['add']`)
- `description` — Что делает инструмент (показывается LLM)
- `input` — Определения параметров:

```javascript
{
  param: { type: 'string' },             // full form
  other: 'number',                       // shorthand
  optional: { type: 'string', required: false },
}
```

- `handler` — Функция, которая выполняется при вызове инструмента:

```javascript
handler: async ({ param, other }) => {
  return { result: 'something' };        // any JSON-serializable value
}
```

### Правила для handler

- Должен быть `async` (или возвращать Promise)
- Получает один аргумент-объект с входными параметрами
- Должен возвращать значение, сериализуемое в JSON
- Имеет полный доступ к импортам, замыканиям и области модуля
- Выполняется в дочернем процессе (мост функций)

### Больше примеров

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

## API навыка MCP

```javascript
skill(id, config)
```

Объект конфигурации:

| Свойство | Обязательно | Описание |
|---|---|---|
| `resolve(options)` | Да | Возвращает `{ command, args, env }` или `null` |
| `serverName` | Нет | Имя сервера MCP (по умолчанию `id`) |
| `allowedTools` | Нет | Шаблоны инструментов (по умолчанию `['mcp__<serverName>__*']`) |
| `envKeys` | Нет | Переменные окружения, нужные навыку |
| `description` | Нет | Человекочитаемое описание |
| `tools` | Нет | Схемы инструментов для валидации на этапе компиляции |
| `cursorKey` | Нет | Переопределить ключ в `~/.cursor/mcp.json` |
| `sessionEnvKey` | Нет | Переменная окружения для путей артефактов сессии (только Cursor) |

### Продвинутый пример: пользовательский бинарник с запасным вариантом

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

## Как это работает внутри

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

**Claude**: SDK получает `mcpServers` в качестве параметра. Он запускает сервер MCP как дочерний процесс, подключается через stdio и направляет вызовы инструментов через него.

**Cursor**: Движок записывает `~/.cursor/mcp.json` на диск перед запуском CLI `agent`. Cursor читает этот файл и сам управляет серверами MCP.

Стратегии никогда не ссылаются на навык по имени. Они перебирают определения навыков и вызывают `resolve()` для каждого.

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

## Сопутствующие пакеты

| Пакет | Что добавляет |
|---|---|
| [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) | Движок графов. Навыки отсюда подключаются к его узлам. |
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | Команда `zibby` — scaffold, dev-сервер, deploy, trigger, logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Встроенные стратегии агентов (Claude / Cursor / Codex / Gemini / OpenAI Assistant), MCP-клиент, среда выполнения. |

---

## Лицензия

MIT
