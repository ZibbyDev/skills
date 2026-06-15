# @zibby/skills — Deutsch

[![npm version](https://img.shields.io/npm/v/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![Types](https://img.shields.io/npm/types/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Español](./README.es.md) | [français](./README.fr.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **Vollständige Doku:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **Die Skill-Ebene für [@zibby/agent-workflow](https://github.com/ZibbyDev/agent-workflow).** Integrierte Skill-Definitionen, die einem Workflow-Knoten die benötigten Werkzeuge geben — Funktions-Tools, MCP-Server, Browser, Issue-Tracker, Memory. Anbieterneutral, JavaScript-first.

`@zibby/skills` ist das voll ausgestattete Gegenstück zu [`@zibby/agent-workflow`](https://github.com/ZibbyDev/agent-workflow) ([npm](https://www.npmjs.com/package/@zibby/agent-workflow)) — *„Graph-based AI agent workflow orchestration."* Die Workflow-Engine liefert bewusst **null Skills** mit; in diesem Paket leben die integrierten.

Ein **Skill** ist der Vertrag zwischen einem Workflow-Knoten und einem Werkzeug. Er sagt der Engine, was das Werkzeug tut, wie es gestartet wird und was es benötigt. Die Engine codiert niemals einen Skill anhand seines Namens fest — sie liest die Skill-Definition und verdrahtet alles generisch, sowohl für Claude- als auch für Cursor-Agenten.

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

## Verwendung mit @zibby/agent-workflow

`@zibby/skills` wird nicht eigenständig verwendet — es klinkt sich in [@zibby/agent-workflow](https://github.com/ZibbyDev/agent-workflow) ein. Ein Knoten benennt die gewünschten Skills in seinem `skills:`-Array, und die Workflow-Engine löst sie zur Laufzeit auf:

```bash
npm install @zibby/agent-workflow @zibby/skills
```

```javascript
// 1. Import the package to register all built-in skills
import '@zibby/skills';
```

Definiere einen Skill einmal …

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

… und ein **@zibby/agent-workflow-Knoten** fordert ihn per ID an:

```javascript
// Used by an @zibby/agent-workflow node
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

Wenn die Engine `do_math` ausführt, sieht sie `skills: ['add']`, schlägt den Skill nach, ruft `resolve()` auf und übergibt das resultierende Werkzeug an den Agenten, der den Knoten ausführt. Siehe [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) dafür, wie Knoten, Graphen und State zusammenpassen.

---

## Schnellstart

```bash
npm install @zibby/skills
```

Importiere das Paket, um alle integrierten Skills zu registrieren:

```javascript
import '@zibby/skills';
```

---

## Die `skill()`-Factory

Eine Funktion, um jeden Skill zu erstellen. Erkennt den Typ automatisch und registriert ihn automatisch.

### Funktions-Skill

Ein Skill = ein Werkzeug. Flach, ohne Verschachtelung.

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

In einem @zibby/agent-workflow-Knoten verwenden:

```javascript
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

### MCP-Skill

Zum Einbinden bestehender MCP-Server-Pakete:

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

## Integrierte Skills

| ID | Server | MCP-Paket |
|----|--------|-------------|
| `browser` | `playwright` | `@zibby/mcp-browser` / `@playwright/mcp` |
| `jira` | `jira` | `@zibby/mcp-jira` |
| `github` | `github` | `@modelcontextprotocol/server-github` |
| `slack` | `slack` | `@modelcontextprotocol/server-slack` |

---

## Funktions-Skill-API

```javascript
skill(id, { description, input, handler })
```

- `id` — Eindeutige Skill-Kennung (verwendet in `skills: ['add']`)
- `description` — Was das Werkzeug tut (dem LLM angezeigt)
- `input` — Parameterdefinitionen:

```javascript
{
  param: { type: 'string' },             // full form
  other: 'number',                       // shorthand
  optional: { type: 'string', required: false },
}
```

- `handler` — Die Funktion, die beim Aufruf des Werkzeugs läuft:

```javascript
handler: async ({ param, other }) => {
  return { result: 'something' };        // any JSON-serializable value
}
```

### Handler-Regeln

- Muss `async` sein (oder ein Promise zurückgeben)
- Erhält ein Objekt-Argument mit den Eingabeparametern
- Muss einen JSON-serialisierbaren Wert zurückgeben
- Hat vollen Zugriff auf Importe, Closures und den Modul-Scope
- Läuft in einem Kindprozess (der Funktions-Bridge)

### Weitere Beispiele

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

## MCP-Skill-API

```javascript
skill(id, config)
```

Konfigurationsobjekt:

| Eigenschaft | Erforderlich | Beschreibung |
|---|---|---|
| `resolve(options)` | Ja | Gibt `{ command, args, env }` oder `null` zurück |
| `serverName` | Nein | MCP-Servername (Standard: `id`) |
| `allowedTools` | Nein | Tool-Muster (Standard: `['mcp__<serverName>__*']`) |
| `envKeys` | Nein | Umgebungsvariablen, die der Skill benötigt |
| `description` | Nein | Menschenlesbare Beschreibung |
| `tools` | Nein | Tool-Schemata für Validierung zur Kompilierzeit |
| `cursorKey` | Nein | Schlüssel in `~/.cursor/mcp.json` überschreiben |
| `sessionEnvKey` | Nein | Umgebungsvariable für Session-Artefaktpfade (nur Cursor) |

### Fortgeschrittenes Beispiel: eigenes Binary mit Fallback

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

## Wie es unter der Haube funktioniert

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

**Claude**: Das SDK erhält `mcpServers` als Parameter. Es startet den MCP-Server als Kindprozess, verbindet sich über stdio und leitet Tool-Aufrufe durch ihn.

**Cursor**: Die Engine schreibt `~/.cursor/mcp.json` auf die Festplatte, bevor die `agent`-CLI gestartet wird. Cursor liest diese Datei und verwaltet die MCP-Server selbst.

Die Strategien referenzieren niemals einen Skill anhand seines Namens. Sie iterieren über die Skill-Definitionen und rufen für jede `resolve()` auf.

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

## Begleitpakete

| Paket | Was es hinzufügt |
|---|---|
| [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) | Die Graph-Engine. Die Skills hier klinken sich in ihre Knoten ein. |
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | `zibby`-Befehl — Scaffold, Dev-Server, Deploy, Trigger, Logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Integrierte Agent-Strategien (Claude / Cursor / Codex / Gemini / OpenAI Assistant), MCP-Client, Laufzeit. |

---

## Lizenz

MIT
