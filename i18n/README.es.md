# @zibby/skills — Español

[![npm version](https://img.shields.io/npm/v/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![Types](https://img.shields.io/npm/types/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [français](./README.fr.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **Documentación completa:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **La capa de skills para [@zibby/agent-workflow](https://github.com/ZibbyHQ/agent-workflow).** Definiciones de skills integradas que dan a un nodo de workflow las herramientas que necesita: herramientas de función, servidores MCP, navegador, gestores de incidencias, memoria. Neutral respecto al proveedor, JavaScript primero.

`@zibby/skills` es el complemento con todo incluido de [`@zibby/agent-workflow`](https://github.com/ZibbyHQ/agent-workflow) ([npm](https://www.npmjs.com/package/@zibby/agent-workflow)) — *"Graph-based AI agent workflow orchestration."* El motor de workflow no incluye **ningún skill** a propósito; este paquete es donde viven los integrados.

Un **skill** es el contrato entre un nodo de workflow y una herramienta. Le dice al motor qué hace la herramienta, cómo iniciarla y qué necesita. El motor nunca codifica ningún skill por su nombre: lee la definición del skill y conecta todo de forma genérica, tanto para agentes Claude como Cursor.

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

## Uso con @zibby/agent-workflow

No usas `@zibby/skills` por sí solo: se conecta a [@zibby/agent-workflow](https://github.com/ZibbyHQ/agent-workflow). Un nodo nombra los skills que quiere en su array `skills:`, y el motor de workflow los resuelve en tiempo de ejecución:

```bash
npm install @zibby/agent-workflow @zibby/skills
```

```javascript
// 1. Import the package to register all built-in skills
import '@zibby/skills';
```

Define un skill una vez…

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

…y un **nodo de @zibby/agent-workflow** lo solicita por su id:

```javascript
// Used by an @zibby/agent-workflow node
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

Cuando el motor ejecuta `do_math`, ve `skills: ['add']`, busca el skill, llama a `resolve()` y entrega la herramienta resultante al agente que ejecuta el nodo. Consulta [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) para ver cómo encajan nodos, grafos y estado.

---

## Inicio rápido

```bash
npm install @zibby/skills
```

Importa el paquete para registrar todos los skills integrados:

```javascript
import '@zibby/skills';
```

---

## La factory `skill()`

Una función para crear cualquier skill. Detecta el tipo automáticamente y lo registra automáticamente.

### Skill de función

Un skill = una herramienta. Plano, sin anidamiento.

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

Úsalo en un nodo de @zibby/agent-workflow:

```javascript
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

### Skill MCP

Para envolver paquetes de servidores MCP existentes:

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

## Skills integrados

| ID | Servidor | Paquete MCP |
|----|--------|-------------|
| `browser` | `playwright` | `@zibby/mcp-browser` / `@playwright/mcp` |
| `jira` | `jira` | `@zibby/mcp-jira` |
| `github` | `github` | `@modelcontextprotocol/server-github` |
| `slack` | `slack` | `@modelcontextprotocol/server-slack` |

---

## API del skill de función

```javascript
skill(id, { description, input, handler })
```

- `id` — Identificador único del skill (usado en `skills: ['add']`)
- `description` — Lo que hace la herramienta (mostrado al LLM)
- `input` — Definiciones de parámetros:

```javascript
{
  param: { type: 'string' },             // full form
  other: 'number',                       // shorthand
  optional: { type: 'string', required: false },
}
```

- `handler` — La función que se ejecuta cuando se llama a la herramienta:

```javascript
handler: async ({ param, other }) => {
  return { result: 'something' };        // any JSON-serializable value
}
```

### Reglas del handler

- Debe ser `async` (o devolver una Promise)
- Recibe un argumento objeto con los parámetros de entrada
- Debe devolver un valor serializable a JSON
- Tiene acceso completo a imports, closures y el scope del módulo
- Se ejecuta en un proceso hijo (el puente de funciones)

### Más ejemplos

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

## API del skill MCP

```javascript
skill(id, config)
```

Objeto de configuración:

| Propiedad | Requerido | Descripción |
|---|---|---|
| `resolve(options)` | Sí | Devuelve `{ command, args, env }` o `null` |
| `serverName` | No | Nombre del servidor MCP (por defecto `id`) |
| `allowedTools` | No | Patrones de herramientas (por defecto `['mcp__<serverName>__*']`) |
| `envKeys` | No | Variables de entorno que necesita el skill |
| `description` | No | Descripción legible por humanos |
| `tools` | No | Esquemas de herramientas para validación en tiempo de compilación |
| `cursorKey` | No | Sobrescribe la clave en `~/.cursor/mcp.json` |
| `sessionEnvKey` | No | Variable de entorno para rutas de artefactos de sesión (solo Cursor) |

### Ejemplo avanzado: binario personalizado con fallback

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

## Cómo funciona por dentro

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

**Claude**: El SDK recibe `mcpServers` como parámetro. Inicia el servidor MCP como proceso hijo, se conecta vía stdio y enruta las llamadas a herramientas a través de él.

**Cursor**: El motor escribe `~/.cursor/mcp.json` en disco antes de iniciar la CLI `agent`. Cursor lee ese archivo y gestiona los servidores MCP por sí mismo.

Las estrategias nunca referencian ningún skill por su nombre. Recorren las definiciones de skills y llaman a `resolve()` en cada una.

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

## Paquetes complementarios

| Paquete | Qué añade |
|---|---|
| [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) | El motor de grafos. Los skills aquí se conectan a sus nodos. |
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | Comando `zibby` — scaffold, servidor de desarrollo, deploy, trigger, logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Estrategias de agente integradas (Claude / Cursor / Codex / Gemini / OpenAI Assistant), cliente MCP, runtime. |

---

## Licencia

MIT
