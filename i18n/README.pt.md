# @zibby/skills — Português

[![npm version](https://img.shields.io/npm/v/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![Types](https://img.shields.io/npm/types/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [français](./README.fr.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **Documentação completa:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **A camada de skills para o [@zibby/agent-workflow](https://github.com/ZibbyHQ/agent-workflow).** Definições de skills integradas que dão a um nó de workflow as ferramentas de que ele precisa — ferramentas de função, servidores MCP, navegador, rastreadores de issues, memória. Neutra em relação ao fornecedor, JavaScript em primeiro lugar.

`@zibby/skills` é o complemento completo do [`@zibby/agent-workflow`](https://github.com/ZibbyHQ/agent-workflow) ([npm](https://www.npmjs.com/package/@zibby/agent-workflow)) — *"Graph-based AI agent workflow orchestration."* O motor de workflow não inclui **nenhum skill** de propósito; este pacote é onde vivem os integrados.

Um **skill** é o contrato entre um nó de workflow e uma ferramenta. Ele diz ao motor o que a ferramenta faz, como iniciá-la e o que ela precisa. O motor nunca codifica nenhum skill pelo nome — ele lê a definição do skill e conecta tudo de forma genérica, tanto para agentes Claude quanto Cursor.

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

## Uso com @zibby/agent-workflow

Você não usa `@zibby/skills` sozinho — ele se conecta ao [@zibby/agent-workflow](https://github.com/ZibbyHQ/agent-workflow). Um nó nomeia os skills que deseja em seu array `skills:`, e o motor de workflow os resolve em tempo de execução:

```bash
npm install @zibby/agent-workflow @zibby/skills
```

```javascript
// 1. Import the package to register all built-in skills
import '@zibby/skills';
```

Defina um skill uma vez…

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

…e um **nó do @zibby/agent-workflow** o solicita pelo id:

```javascript
// Used by an @zibby/agent-workflow node
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

Quando o motor executa `do_math`, ele vê `skills: ['add']`, procura o skill, chama `resolve()` e entrega a ferramenta resultante ao agente que executa o nó. Veja [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) para entender como nós, grafos e estado se encaixam.

---

## Início rápido

```bash
npm install @zibby/skills
```

Importe o pacote para registrar todos os skills integrados:

```javascript
import '@zibby/skills';
```

---

## A factory `skill()`

Uma função para criar qualquer skill. Detecta o tipo automaticamente e o registra automaticamente.

### Skill de função

Um skill = uma ferramenta. Plano, sem aninhamento.

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

Use-o em um nó do @zibby/agent-workflow:

```javascript
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

### Skill MCP

Para encapsular pacotes de servidores MCP existentes:

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

| ID | Servidor | Pacote MCP |
|----|--------|-------------|
| `browser` | `playwright` | `@zibby/mcp-browser` / `@playwright/mcp` |
| `jira` | `jira` | `@zibby/mcp-jira` |
| `github` | `github` | `@modelcontextprotocol/server-github` |
| `slack` | `slack` | `@modelcontextprotocol/server-slack` |

---

## API do skill de função

```javascript
skill(id, { description, input, handler })
```

- `id` — Identificador único do skill (usado em `skills: ['add']`)
- `description` — O que a ferramenta faz (mostrado ao LLM)
- `input` — Definições de parâmetros:

```javascript
{
  param: { type: 'string' },             // full form
  other: 'number',                       // shorthand
  optional: { type: 'string', required: false },
}
```

- `handler` — A função que roda quando a ferramenta é chamada:

```javascript
handler: async ({ param, other }) => {
  return { result: 'something' };        // any JSON-serializable value
}
```

### Regras do handler

- Deve ser `async` (ou retornar uma Promise)
- Recebe um argumento objeto com os parâmetros de entrada
- Deve retornar um valor serializável em JSON
- Tem acesso completo a imports, closures e ao escopo do módulo
- Roda em um processo filho (a ponte de funções)

### Mais exemplos

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

## API do skill MCP

```javascript
skill(id, config)
```

Objeto de configuração:

| Propriedade | Obrigatório | Descrição |
|---|---|---|
| `resolve(options)` | Sim | Retorna `{ command, args, env }` ou `null` |
| `serverName` | Não | Nome do servidor MCP (padrão `id`) |
| `allowedTools` | Não | Padrões de ferramentas (padrão `['mcp__<serverName>__*']`) |
| `envKeys` | Não | Variáveis de ambiente que o skill precisa |
| `description` | Não | Descrição legível por humanos |
| `tools` | Não | Esquemas de ferramentas para validação em tempo de compilação |
| `cursorKey` | Não | Sobrescreve a chave em `~/.cursor/mcp.json` |
| `sessionEnvKey` | Não | Variável de ambiente para caminhos de artefatos de sessão (apenas Cursor) |

### Exemplo avançado: binário personalizado com fallback

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

## Como funciona por dentro

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

**Claude**: O SDK recebe `mcpServers` como parâmetro. Ele inicia o servidor MCP como processo filho, conecta-se via stdio e roteia as chamadas de ferramentas através dele.

**Cursor**: O motor escreve `~/.cursor/mcp.json` em disco antes de iniciar a CLI `agent`. O Cursor lê esse arquivo e gerencia os servidores MCP por conta própria.

As estratégias nunca referenciam nenhum skill pelo nome. Elas percorrem as definições de skills e chamam `resolve()` em cada uma.

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

## Pacotes complementares

| Pacote | O que ele adiciona |
|---|---|
| [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) | O motor de grafos. Os skills aqui se conectam aos seus nós. |
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | Comando `zibby` — scaffold, servidor de dev, deploy, trigger, logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Estratégias de agente integradas (Claude / Cursor / Codex / Gemini / OpenAI Assistant), cliente MCP, runtime. |

---

## Licença

MIT
