# @zibby/skills — français

[![npm version](https://img.shields.io/npm/v/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![Types](https://img.shields.io/npm/types/@zibby/skills.svg)](https://www.npmjs.com/package/@zibby/skills)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **Documentation complète :** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **La couche de skills pour [@zibby/agent-workflow](https://github.com/ZibbyHQ/agent-workflow).** Des définitions de skills intégrées qui donnent à un nœud de workflow les outils dont il a besoin — outils de fonction, serveurs MCP, navigateur, gestionnaires de tickets, mémoire. Neutre vis-à-vis des fournisseurs, JavaScript d'abord.

`@zibby/skills` est le complément clé en main de [`@zibby/agent-workflow`](https://github.com/ZibbyHQ/agent-workflow) ([npm](https://www.npmjs.com/package/@zibby/agent-workflow)) — *« Graph-based AI agent workflow orchestration. »* Le moteur de workflow ne fournit **aucun skill** à dessein ; c'est dans ce paquet que vivent les skills intégrés.

Un **skill** est le contrat entre un nœud de workflow et un outil. Il indique au moteur ce que fait l'outil, comment le démarrer et ce dont il a besoin. Le moteur ne code jamais en dur un skill par son nom — il lit la définition du skill et câble tout de manière générique, à la fois pour les agents Claude et Cursor.

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

## Utilisation avec @zibby/agent-workflow

`@zibby/skills` ne s'utilise pas seul — il se branche sur [@zibby/agent-workflow](https://github.com/ZibbyHQ/agent-workflow). Un nœud nomme les skills qu'il souhaite dans son tableau `skills:`, et le moteur de workflow les résout à l'exécution :

```bash
npm install @zibby/agent-workflow @zibby/skills
```

```javascript
// 1. Import the package to register all built-in skills
import '@zibby/skills';
```

Définissez un skill une fois…

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

… et un **nœud @zibby/agent-workflow** le demande par son id :

```javascript
// Used by an @zibby/agent-workflow node
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

Lorsque le moteur exécute `do_math`, il voit `skills: ['add']`, recherche le skill, appelle `resolve()` et transmet l'outil résultant à l'agent qui exécute le nœud. Voir [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) pour comprendre comment s'articulent nœuds, graphes et état.

---

## Démarrage rapide

```bash
npm install @zibby/skills
```

Importez le paquet pour enregistrer tous les skills intégrés :

```javascript
import '@zibby/skills';
```

---

## La factory `skill()`

Une fonction pour créer n'importe quel skill. Détecte le type automatiquement et l'enregistre automatiquement.

### Skill de fonction

Un skill = un outil. Plat, sans imbrication.

```javascript
import { skill } from '@zibby/skills';

export const add = skill('add', {
  description: 'Add two numbers',
  input: { a: 'number', b: 'number' },
  handler: async ({ a, b }) => ({ result: a + b })
});
```

Utilisez-le dans un nœud @zibby/agent-workflow :

```javascript
export const mathNode = {
  name: 'do_math',
  skills: ['add'],
  prompt: (state) => `Add ${state.a} and ${state.b}`,
};
```

### Skill MCP

Pour encapsuler des paquets de serveurs MCP existants :

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

## Skills intégrés

| ID | Serveur | Paquet MCP |
|----|--------|-------------|
| `browser` | `playwright` | `@zibby/mcp-browser` / `@playwright/mcp` |
| `jira` | `jira` | `@zibby/mcp-jira` |
| `github` | `github` | `@modelcontextprotocol/server-github` |
| `slack` | `slack` | `@modelcontextprotocol/server-slack` |

---

## API du skill de fonction

```javascript
skill(id, { description, input, handler })
```

- `id` — Identifiant unique du skill (utilisé dans `skills: ['add']`)
- `description` — Ce que fait l'outil (montré au LLM)
- `input` — Définitions des paramètres :

```javascript
{
  param: { type: 'string' },             // full form
  other: 'number',                       // shorthand
  optional: { type: 'string', required: false },
}
```

- `handler` — La fonction qui s'exécute lorsque l'outil est appelé :

```javascript
handler: async ({ param, other }) => {
  return { result: 'something' };        // any JSON-serializable value
}
```

### Règles du handler

- Doit être `async` (ou retourner une Promise)
- Reçoit un argument objet contenant les paramètres d'entrée
- Doit retourner une valeur sérialisable en JSON
- A un accès complet aux imports, closures et à la portée du module
- S'exécute dans un processus enfant (le pont de fonctions)

### Autres exemples

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

## API du skill MCP

```javascript
skill(id, config)
```

Objet de configuration :

| Propriété | Requis | Description |
|---|---|---|
| `resolve(options)` | Oui | Retourne `{ command, args, env }` ou `null` |
| `serverName` | Non | Nom du serveur MCP (par défaut `id`) |
| `allowedTools` | Non | Motifs d'outils (par défaut `['mcp__<serverName>__*']`) |
| `envKeys` | Non | Variables d'environnement dont le skill a besoin |
| `description` | Non | Description lisible par un humain |
| `tools` | Non | Schémas d'outils pour validation à la compilation |
| `cursorKey` | Non | Remplacer la clé dans `~/.cursor/mcp.json` |
| `sessionEnvKey` | Non | Variable d'environnement pour les chemins d'artefacts de session (Cursor uniquement) |

### Exemple avancé : binaire personnalisé avec repli

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

## Fonctionnement interne

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

**Claude** : Le SDK reçoit `mcpServers` en paramètre. Il démarre le serveur MCP en tant que processus enfant, se connecte via stdio et achemine les appels d'outils à travers lui.

**Cursor** : Le moteur écrit `~/.cursor/mcp.json` sur le disque avant de démarrer la CLI `agent`. Cursor lit ce fichier et gère lui-même les serveurs MCP.

Les stratégies ne référencent jamais un skill par son nom. Elles parcourent les définitions de skills et appellent `resolve()` sur chacune.

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

## Paquets compagnons

| Paquet | Ce qu'il apporte |
|---|---|
| [`@zibby/agent-workflow`](https://www.npmjs.com/package/@zibby/agent-workflow) | Le moteur de graphes. Les skills ici se branchent sur ses nœuds. |
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | Commande `zibby` — scaffold, serveur de dev, deploy, trigger, logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Stratégies d'agent intégrées (Claude / Cursor / Codex / Gemini / OpenAI Assistant), client MCP, runtime. |

---

## Licence

MIT
