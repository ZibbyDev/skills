/**
 * Workflow Builder Skill
 *
 * Guides users through designing and building custom AI workflows
 * via conversation. The chat agent (assistant) handles the dialog;
 * this skill provides tools that generate real workflow code by
 * delegating to the user's configured agent (cursor/claude/codex/gemini).
 *
 * No MCP server needed — all handlers run locally.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join, resolve, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Prompt fragment: teaches the assistant about the workflow framework ──

const PROMPT_FRAGMENT = `## Workflow Builder

You can help users build custom AI workflows using the Zibby workflow framework.

### What makes Zibby workflows different
Each node invokes a **real AI agent** (Cursor, Claude, Codex, or Gemini) — not a thin LLM API wrapper.
That means every node has full agent capabilities: tool use, MCP servers (browser, GitHub, Jira, Slack),
multi-turn reasoning, and structured output validation via Zod schemas.

Key differentiators:
- **Agent-powered nodes** — each step runs a full AI agent (cursor-agent, claude, codex, gemini CLI) with tool access and MCP skills, not a simple chat completion call.
- **Structured output** — every node declares a Zod schema; the framework validates and parses the agent's response automatically.
- **Conditional routing** — edges can branch on agent-produced fields (e.g., \`state.triage.priority === 'critical'\`), enabling intelligent decision graphs.
- **MCP skill injection** — nodes declare \`skills: [SKILLS.BROWSER, SKILLS.GITHUB]\` and the framework spins up the right MCP servers automatically.
- **Deploy anywhere** — \`zibby deploy\` pushes to Zibby Cloud with an API trigger; or self-host with \`zibby start\`.
- **State accumulation** — each node's validated output is stored under its name in \`state\` (e.g., \`state.classify_ticket\`), so downstream nodes can reference upstream results.

### What is a workflow?
A directed graph of nodes (AI agent steps) connected by edges. Each node has:
- \`name\` — unique identifier (snake_case)
- \`prompt\` — function that receives state and returns the prompt string sent to the agent
- \`outputSchema\` — Zod schema defining the structured output the agent must return
- \`skills\` (optional) — array of MCP skill IDs the node needs (e.g., \`SKILLS.BROWSER\`, \`SKILLS.GITHUB\`)
- \`timeout\` (optional) — max execution time in ms (default: 300000)
- \`model\` (optional) — override the model for this node (e.g., \`'claude-opus-4'\`)

### File structure
\`\`\`
.zibby/workflows/<name>/
├── graph.mjs          — WorkflowAgent subclass with buildGraph()
├── nodes/
│   ├── index.mjs      — barrel export for all nodes
│   └── <node>.mjs     — one file per node
└── workflow.json       — manifest (name, description, triggers)
\`\`\`

### Node pattern
\`\`\`javascript
import { z, SKILLS } from '@zibby/core';

const OutputSchema = z.object({
  summary: z.string().describe('Brief summary'),
  items: z.array(z.string()).describe('List of extracted items'),
  needsReview: z.boolean().describe('Whether a human should review this'),
});

export const myNode = {
  name: 'my_node',
  skills: [SKILLS.GITHUB],  // optional — framework injects MCP servers
  timeout: 120000,           // optional — 2 min timeout
  prompt: (state) => \\\`You are analyzing a pull request.

Input:
\\\${JSON.stringify(state.input || {}, null, 2)}

Return a JSON object matching the schema.\\\`,
  outputSchema: OutputSchema,
};
\`\`\`

### Graph pattern
\`\`\`javascript
import { WorkflowAgent, WorkflowGraph } from '@zibby/core';
import { classifyNode, routeNode } from './nodes/index.mjs';

export class MyWorkflow extends WorkflowAgent {
  buildGraph() {
    const graph = new WorkflowGraph();
    graph.addNode('classify', classifyNode);
    graph.addNode('route', routeNode);
    graph.setEntryPoint('classify');
    graph.addEdge('classify', 'route');
    graph.addEdge('route', 'END');
    return graph;
  }

  async onComplete(result) {
    // Post-execution hook — save artifacts, notify, etc.
    console.log('Workflow complete:', result.success);
  }
}
\`\`\`

Conditional edges: \`graph.addConditionalEdges('node', (state) => state.node.priority === 'high' ? 'escalate' : 'notify')\`

### Available SKILLS constants
Import from \`@zibby/core\`: \`SKILLS.BROWSER\`, \`SKILLS.MEMORY\`, \`SKILLS.GITHUB\`, \`SKILLS.JIRA\`, \`SKILLS.SLACK\`, \`SKILLS.RUNNER\`

### Deep documentation
Call \`explore_framework_docs\` to read detailed framework docs on demand. Use it for:
- Advanced patterns (middleware, parallel nodes, state schemas)
- Deployment & cloud triggers
- CLI commands reference
- Integration details (Jira, GitHub, etc.)
Call with no arguments to see all available topics.

### How to use the builder tools
1. For complex workflows, call \`explore_framework_docs("custom-workflows")\` first to learn advanced patterns.
2. Ask the user what their workflow should do, what input it receives, and what steps are needed.
3. Call \`design_workflow\` with the structured spec for the user to review.
4. Once approved, call \`build_workflow\` to generate real code on disk (uses the configured agent for high-quality code generation).
5. Remind the user: \`zibby start <name>\` to test locally, \`zibby deploy <name> --project <id>\` to deploy to cloud, \`zibby logs --workflow <name>\` to tail logs.

### Important
- Each node prompt should be detailed and specific — tell the AI agent exactly what to do and what format to return.
- Zod schemas MUST use .describe() on every field so the agent knows what each field means.
- Node names must be snake_case (e.g., classify_ticket, generate_report).
- Workflow names must be kebab-case (e.g., ticket-triage, pr-review).
- State flows through: each node's validated output is stored under its name in state (e.g., state.classify_ticket).
- Downstream nodes reference upstream outputs in their prompt function (e.g., \\\`\\\${JSON.stringify(state.classify_ticket, null, 2)}\\\`).
- Nodes can declare skills to get MCP tool access — the framework handles server lifecycle automatically.`;

// ── Slug validation (same as CLI) ──

const WORKFLOW_SLUG_RE = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

function toClassName(slug) {
  return `${slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')}Workflow`;
}

function toNodeExportName(name) {
  return `${name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())}Node`;
}

// ── Infer agent type from .zibby.config.mjs ──

function inferAgentFromConfig(config) {
  const ac = config?.agent;
  if (!ac) return process.env.AGENT_TYPE || 'cursor';
  if (ac.provider) return ac.provider;
  if (ac.gemini) return 'gemini';
  if (ac.codex) return 'codex';
  if (ac.claude) return 'claude';
  if (ac.cursor) return 'cursor';
  return process.env.AGENT_TYPE || 'cursor';
}

async function loadProjectConfig(cwd) {
  const configPath = resolve(cwd, '.zibby.config.mjs');
  if (!existsSync(configPath)) return {};
  try {
    const mod = await import(configPath);
    return mod.default || {};
  } catch {
    return {};
  }
}

// ── Reference examples loaded from the built-in template ──

function loadReferenceExamples() {
  try {
    const corePath = dirname(require.resolve('@zibby/core/package.json'));
    const templateDir = join(corePath, 'templates', 'browser-test-automation');

    const preflight = readFileSync(join(templateDir, 'nodes', 'preflight.mjs'), 'utf-8');
    const graph = readFileSync(join(templateDir, 'graph.mjs'), 'utf-8');
    return { preflight, graph };
  } catch {
    return null;
  }
}

// ── Framework docs resolution ──
// Monorepo: read from docsite/docs/ (always latest)
// npm install: read from bundled docs/ (copied by prepack)

const _skillsPkgDir = dirname(fileURLToPath(import.meta.url));

function resolveDocsDir() {
  const monorepoPath = resolve(_skillsPkgDir, '..', '..', '..', 'docsite', 'docs');
  if (existsSync(monorepoPath)) return monorepoPath;
  const bundledPath = resolve(_skillsPkgDir, '..', 'docs');
  if (existsSync(bundledPath)) return bundledPath;
  return null;
}

function listAvailableDocs() {
  const docsDir = resolveDocsDir();
  if (!docsDir) return [];
  try {
    const walk = (dir, prefix = '') => {
      let results = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (statSync(full).isDirectory()) {
            results = results.concat(walk(full, `${prefix}${entry}/`));
          } else if (entry.endsWith('.md')) {
            const topic = `${prefix}${entry.replace(/\.md$/, '')}`;
            results.push(topic);
          }
        } catch { /* skip unreadable */ }
      }
      return results;
    };
    return walk(docsDir);
  } catch {
    return [];
  }
}

function readDoc(topic) {
  const docsDir = resolveDocsDir();
  if (!docsDir) return null;
  const filePath = join(docsDir, `${topic}.md`);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ── Code generation via invokeAgent ──

function buildCodeGenPrompt(spec) {
  const nodeDescriptions = spec.nodes.map(n => {
    const inputs = n.inputFields?.length ? `Input fields: ${n.inputFields.join(', ')}` : 'Input: receives full state';
    const outputs = n.outputFields?.length ? `Output fields: ${n.outputFields.join(', ')}` : 'Output: determined by task';
    const skills = n.skills?.length ? `Skills: ${n.skills.join(', ')}` : '';
    return `- ${n.name}: ${n.description}. ${inputs}. ${outputs}.${skills ? ` ${skills}` : ''}`;
  }).join('\n');

  const edgeDescriptions = spec.edges.map(e => {
    if (e.condition) return `- ${e.from} → ${e.to} (conditional: ${e.condition})`;
    return `- ${e.from} → ${e.to}`;
  }).join('\n');

  const examples = loadReferenceExamples();
  const customWorkflowsDocs = readDoc('custom-workflows');

  let referenceSection = '';
  if (examples) {
    referenceSection += `
## Real working examples from the Zibby framework

### Example node (preflight.mjs) — a prompt-only node with Zod schema and onComplete hook:
\`\`\`javascript
${examples.preflight}
\`\`\`

### Example graph (graph.mjs) — WorkflowAgent subclass with conditional routing:
\`\`\`javascript
${examples.graph}
\`\`\`

Study these examples carefully. Your generated code must follow the same patterns exactly.
`;
  }
  if (customWorkflowsDocs) {
    referenceSection += `
## Full framework documentation (Custom Workflows)
${customWorkflowsDocs}
`;
  }

  return `Generate the code for a Zibby workflow called "${spec.name}".

## Zibby Workflow Framework Reference

Zibby workflows are directed graphs where each node invokes a **real AI agent** (Cursor, Claude, Codex, or Gemini)
with full tool access, MCP server integration, and Zod-validated structured output.
This is NOT a simple LLM API wrapper — each node runs a full agent with tool-calling capabilities.

### Architecture
- The framework calls the configured AI agent for each node.
- Each node's \`prompt\` function receives the accumulated \`state\` object and returns a prompt string.
- The agent's response is parsed and validated against the node's \`outputSchema\` (Zod).
- The validated output is stored in \`state\` under the node's name (e.g., \`state.classify_ticket\`).
- Downstream nodes access upstream results via \`state.<upstream_node_name>\`.

### Node properties
- \`name\` (string, required) — snake_case identifier
- \`prompt\` (function, required) — \`(state) => \\\`...\\\`\` returns the prompt string
- \`outputSchema\` (Zod schema, required) — every field MUST have \`.describe()\`
- \`skills\` (array, optional) — MCP skills: \`[SKILLS.BROWSER]\`, \`[SKILLS.GITHUB]\`, etc.
- \`timeout\` (number, optional) — ms, default 300000
- \`onComplete\` (async function, optional) — \`(state, result) => {}\` post-processing hook

### Available SKILLS constants (import from '@zibby/core')
SKILLS.BROWSER, SKILLS.MEMORY, SKILLS.GITHUB, SKILLS.JIRA, SKILLS.SLACK, SKILLS.RUNNER

### Graph API
- \`graph.addNode(name, nodeObject)\` — register a node
- \`graph.setEntryPoint(name)\` — set the first node
- \`graph.addEdge(from, to)\` — connect nodes (use \`'END'\` to terminate)
- \`graph.addConditionalEdges(from, (state) => 'nextNode' | 'END')\` — conditional routing

### Rules
- Import: \`import { z } from '@zibby/core';\` (add \`SKILLS\` only if the node uses skills)
- Export name: camelCase + "Node" (e.g., \`classifyTicketNode\` for name \`classify_ticket\`)
- Prompt function: template literal referencing \`state.input\` and upstream \`state.<node_name>\`
- Prompts must be detailed — tell the agent exactly what to analyze/produce
${referenceSection}
## Workflow to generate: "${spec.name}"

### Description
${spec.description}

### Nodes
${nodeDescriptions}

### Edges (flow)
${edgeDescriptions}

## Output format

Return a JSON object with this exact structure:
{
  "nodes": {
    "<node_name>": {
      "code": "// complete ESM module code as a string"
    }
  }
}

IMPORTANT: Return ONLY valid JSON. No markdown fences, no explanation outside the JSON.`;
}

async function generateNodeCode(spec, cwd) {
  const config = await loadProjectConfig(cwd);
  const agentType = inferAgentFromConfig(config);

  try {
    const { invokeAgent } = await import('@zibby/core');
    const prompt = buildCodeGenPrompt(spec);

    const result = await invokeAgent(prompt, {
      state: { agentType, config, cwd, workspace: cwd },
    }, {
      model: config?.agent?.[agentType]?.model || 'auto',
      workspace: cwd,
      config,
      timeout: 120000,
    });

    const raw = typeof result === 'string' ? result : (result?.raw || JSON.stringify(result?.structured || result));

    // Extract JSON from the response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Agent did not return valid JSON');
    }

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    // Fallback: generate template code if agent fails
    console.warn(`Agent code generation failed (${err.message}), using templates`);
    return generateFallbackCode(spec);
  }
}

function generateFallbackCode(spec) {
  const nodes = {};
  for (const node of spec.nodes) {
    const exportName = toNodeExportName(node.name);
    const schemaName = `${node.name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')}OutputSchema`;

    const outputFields = node.outputFields?.length
      ? node.outputFields.map(f => `  ${f}: z.string().describe('${f}'),`).join('\n')
      : `  summary: z.string().describe('Summary of the result'),\n  status: z.enum(['ok', 'warn', 'error']).describe('Overall status'),`;

    const upstreamRef = spec.edges
      .filter(e => e.to === node.name && e.from !== 'START')
      .map(e => `Previous step (${e.from}): \${JSON.stringify(state.${e.from} || {}, null, 2)}`)
      .join('\n');

    const promptBody = upstreamRef
      ? `${node.description}\n\nInput:\n\${JSON.stringify(state.input || {}, null, 2)}\n\n${upstreamRef}`
      : `${node.description}\n\nInput:\n\${JSON.stringify(state.input || {}, null, 2)}`;

    nodes[node.name] = {
      code: `import { z } from '@zibby/core';

const ${schemaName} = z.object({
${outputFields}
});

export const ${exportName} = {
  name: '${node.name}',
  prompt: (state) => \`${promptBody}\`,
  outputSchema: ${schemaName},
};
`,
    };
  }
  return { nodes };
}

// ── File writing ──

function writeWorkflowFiles(cwd, name, spec, generatedCode) {
  const slug = name.toLowerCase();
  const className = toClassName(slug);
  const workflowDir = join(cwd, '.zibby', 'workflows', slug);
  const nodesDir = join(workflowDir, 'nodes');

  mkdirSync(nodesDir, { recursive: true });

  // Write node files
  const nodeNames = spec.nodes.map(n => n.name);
  for (const node of spec.nodes) {
    const code = generatedCode.nodes?.[node.name]?.code;
    if (code) {
      writeFileSync(join(nodesDir, `${node.name.replace(/_/g, '-')}.mjs`), code, 'utf-8');
    }
  }

  // Write barrel export
  const barrelLines = nodeNames.map(n => {
    const exportName = toNodeExportName(n);
    const fileName = n.replace(/_/g, '-');
    return `export { ${exportName} } from './${fileName}.mjs';`;
  });
  writeFileSync(join(nodesDir, 'index.mjs'), `${barrelLines.join('\n')}\n`, 'utf-8');

  // Determine entry point and build edge wiring
  const entryNode = nodeNames[0];
  const nodeImports = nodeNames.map(n => toNodeExportName(n)).join(', ');

  const addNodeLines = nodeNames.map(n => `    graph.addNode('${n}', ${toNodeExportName(n)});`).join('\n');

  const edgeLines = spec.edges.map(e => {
    if (e.condition) {
      return `    graph.addConditionalEdges('${e.from}', (state) => {\n      ${e.condition}\n    });`;
    }
    return `    graph.addEdge('${e.from}', '${e.to}');`;
  }).join('\n');

  const graphCode = `import { WorkflowAgent, WorkflowGraph } from '@zibby/core';
import { ${nodeImports} } from './nodes/index.mjs';

export class ${className} extends WorkflowAgent {
  buildGraph() {
    const graph = new WorkflowGraph();

${addNodeLines}

    graph.setEntryPoint('${entryNode}');
${edgeLines}

    return graph;
  }

  async onComplete(result) {
    console.log(\`[${slug}] workflow complete — success: \${result.success !== false}\`);
  }
}
`;

  writeFileSync(join(workflowDir, 'graph.mjs'), graphCode, 'utf-8');

  // Write manifest
  const manifest = {
    name: slug,
    description: spec.description || `${className} workflow`,
    entryClass: className,
    triggers: { api: true },
  };
  writeFileSync(join(workflowDir, 'workflow.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  const files = [
    `graph.mjs`,
    `workflow.json`,
    `nodes/index.mjs`,
    ...nodeNames.map(n => `nodes/${n.replace(/_/g, '-')}.mjs`),
  ];

  return { workflowDir: relative(cwd, workflowDir), files, className, slug };
}

// ── Tool handlers ──

async function handleDesignWorkflow(args) {
  const { name, description, nodes, edges } = args;

  if (!name || !WORKFLOW_SLUG_RE.test(name.toLowerCase())) {
    return JSON.stringify({
      error: `Invalid workflow name "${name}". Must be kebab-case, 2-64 chars, lowercase letters/numbers/hyphens.`,
    });
  }

  if (!nodes || nodes.length === 0) {
    return JSON.stringify({ error: 'At least one node is required.' });
  }

  const spec = {
    name: name.toLowerCase(),
    description: description || `${toClassName(name.toLowerCase())} workflow`,
    nodes: nodes.map(n => ({
      name: n.name.replace(/-/g, '_'),
      description: n.description || `Process ${n.name}`,
      inputFields: n.inputFields || [],
      outputFields: n.outputFields || [],
    })),
    edges: edges || [],
  };

  // Auto-wire linear edges if none provided
  if (spec.edges.length === 0 && spec.nodes.length > 0) {
    for (let i = 0; i < spec.nodes.length - 1; i++) {
      spec.edges.push({ from: spec.nodes[i].name, to: spec.nodes[i + 1].name });
    }
    spec.edges.push({ from: spec.nodes[spec.nodes.length - 1].name, to: 'END' });
  }

  return JSON.stringify({
    ok: true,
    spec,
    message: `Workflow "${spec.name}" designed with ${spec.nodes.length} node(s). Call build_workflow to generate the code.`,
    preview: {
      nodes: spec.nodes.map(n => n.name),
      flow: spec.edges.map(e => e.condition ? `${e.from} →(if ${e.condition})→ ${e.to}` : `${e.from} → ${e.to}`),
    },
  });
}

async function handleBuildWorkflow(args, cwd) {
  const { name, spec } = args;
  const slug = (name || spec?.name || '').toLowerCase();

  if (!slug || !WORKFLOW_SLUG_RE.test(slug)) {
    return JSON.stringify({ error: `Invalid workflow name "${slug}".` });
  }

  if (!spec || !spec.nodes || spec.nodes.length === 0) {
    return JSON.stringify({ error: 'spec with nodes is required. Call design_workflow first.' });
  }

  const workflowDir = join(cwd, '.zibby', 'workflows', slug);
  if (existsSync(workflowDir)) {
    return JSON.stringify({
      error: `Workflow "${slug}" already exists at .zibby/workflows/${slug}/. Delete it first or choose a different name.`,
    });
  }

  const generatedCode = await generateNodeCode(spec, cwd);
  const result = writeWorkflowFiles(cwd, slug, spec, generatedCode);

  return JSON.stringify({
    ok: true,
    ...result,
    message: `Workflow "${slug}" created at ${result.workflowDir}/`,
    nextSteps: [
      `Test locally: zibby start ${slug}`,
      `Deploy to cloud: zibby deploy ${slug} --project <project-id>`,
      `Tail logs: zibby logs --workflow ${slug} --project <project-id>`,
    ],
  });
}

async function handleAddNode(args, cwd) {
  const { workflowName, nodeName, description, inputFields, outputFields } = args;
  const slug = (workflowName || '').toLowerCase();
  const nodeSlug = (nodeName || '').replace(/-/g, '_');

  const workflowDir = join(cwd, '.zibby', 'workflows', slug);
  if (!existsSync(workflowDir)) {
    return JSON.stringify({ error: `Workflow "${slug}" not found. Create it first with build_workflow.` });
  }

  const spec = {
    name: slug,
    description: '',
    nodes: [{ name: nodeSlug, description: description || `Process ${nodeSlug}`, inputFields: inputFields || [], outputFields: outputFields || [] }],
    edges: [],
  };

  const generatedCode = await generateNodeCode(spec, cwd);
  const code = generatedCode.nodes?.[nodeSlug]?.code;
  if (!code) {
    return JSON.stringify({ error: 'Failed to generate node code.' });
  }

  const nodesDir = join(workflowDir, 'nodes');
  const nodeFile = `${nodeSlug.replace(/_/g, '-')}.mjs`;
  writeFileSync(join(nodesDir, nodeFile), code, 'utf-8');

  // Append to barrel export
  const barrelPath = join(nodesDir, 'index.mjs');
  const exportName = toNodeExportName(nodeSlug);
  const exportLine = `export { ${exportName} } from './${nodeSlug.replace(/_/g, '-')}.mjs';\n`;
  const existing = existsSync(barrelPath) ? readFileSync(barrelPath, 'utf-8') : '';
  if (!existing.includes(exportName)) {
    writeFileSync(barrelPath, existing + exportLine, 'utf-8');
  }

  return JSON.stringify({
    ok: true,
    file: `nodes/${nodeFile}`,
    exportName,
    message: `Node "${nodeSlug}" added. Update graph.mjs to wire it into the graph.`,
  });
}

async function handleDeployWorkflow(args, cwd) {
  const { name, projectId } = args;
  const slug = (name || '').toLowerCase();

  if (!slug) return JSON.stringify({ error: 'Workflow name is required.' });
  if (!projectId) return JSON.stringify({ error: 'projectId is required.' });

  const workflowDir = join(cwd, '.zibby', 'workflows', slug);
  if (!existsSync(workflowDir)) {
    return JSON.stringify({ error: `Workflow "${slug}" not found at .zibby/workflows/${slug}/` });
  }

  try {
    const { execSync } = await import('child_process');
    const output = execSync(
      `node "${join(cwd, 'packages/cli/bin/zibby.js')}" deploy ${slug} --project ${projectId}`,
      { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return JSON.stringify({ ok: true, output: output.trim() });
  } catch (_err) {
    // Fallback: try global zibby
    try {
      const { execSync } = await import('child_process');
      const output = execSync(
        `npx zibby deploy ${slug} --project ${projectId}`,
        { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return JSON.stringify({ ok: true, output: output.trim() });
    } catch (e) {
      return JSON.stringify({ error: `Deploy failed: ${e.message}` });
    }
  }
}

function handleListWorkflows(cwd) {
  const workflowsDir = join(cwd, '.zibby', 'workflows');
  if (!existsSync(workflowsDir)) {
    return JSON.stringify({ workflows: [], message: 'No workflows found. Use build_workflow to create one.' });
  }

  const entries = readdirSync(workflowsDir).filter(name => {
    try { return statSync(join(workflowsDir, name)).isDirectory(); } catch { return false; }
  });

  const workflows = entries.map(name => {
    const manifestPath = join(workflowsDir, name, 'workflow.json');
    let manifest = {};
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch { /* */ }
    const nodesDir = join(workflowsDir, name, 'nodes');
    let nodeCount = 0;
    try { nodeCount = readdirSync(nodesDir).filter(f => f.endsWith('.mjs') && f !== 'index.mjs').length; } catch { /* */ }
    return {
      name,
      description: manifest.description || '',
      nodeCount,
      path: relative(cwd, join(workflowsDir, name)),
    };
  });

  return JSON.stringify({ workflows });
}

// ── Skill definition ──

export const workflowBuilderSkill = {
  id: 'workflow-builder',
  description: 'Build, scaffold, and deploy custom AI workflows via conversation',
  envKeys: [],

  promptFragment: PROMPT_FRAGMENT,

  tools: [
    {
      name: 'design_workflow',
      description: 'Design a workflow spec (nodes, edges, descriptions) for the user to review before building. Call this after understanding requirements.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workflow name in kebab-case (e.g., ticket-triage)' },
          description: { type: 'string', description: 'What the workflow does' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Node name in snake_case (e.g., classify_ticket)' },
                description: { type: 'string', description: 'What this node does — be specific about input/output' },
                inputFields: { type: 'array', items: { type: 'string' }, description: 'Key fields this node reads from state' },
                outputFields: { type: 'array', items: { type: 'string' }, description: 'Key fields this node produces' },
              },
              required: ['name', 'description'],
            },
            description: 'Workflow nodes (processing steps)',
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'Source node name' },
                to: { type: 'string', description: 'Target node name (or "END")' },
                condition: { type: 'string', description: 'JS expression for conditional routing (optional)' },
              },
              required: ['from', 'to'],
            },
            description: 'Edges connecting nodes. If omitted, nodes are wired linearly.',
          },
        },
        required: ['name', 'description', 'nodes'],
      },
    },
    {
      name: 'build_workflow',
      description: 'Generate real workflow code on disk from a design spec. Uses the configured AI agent for high-quality code generation.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workflow name (from design_workflow)' },
          spec: {
            type: 'object',
            description: 'The full spec object returned by design_workflow',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              nodes: { type: 'array', items: { type: 'object' } },
              edges: { type: 'array', items: { type: 'object' } },
            },
          },
        },
        required: ['name', 'spec'],
      },
    },
    {
      name: 'add_node',
      description: 'Add a new node to an existing workflow. Generates the node file and updates the barrel export.',
      input_schema: {
        type: 'object',
        properties: {
          workflowName: { type: 'string', description: 'Existing workflow name (kebab-case)' },
          nodeName: { type: 'string', description: 'New node name (snake_case)' },
          description: { type: 'string', description: 'What this node does' },
          inputFields: { type: 'array', items: { type: 'string' }, description: 'Fields read from state' },
          outputFields: { type: 'array', items: { type: 'string' }, description: 'Fields produced' },
        },
        required: ['workflowName', 'nodeName', 'description'],
      },
    },
    {
      name: 'deploy_workflow',
      description: 'Deploy a workflow to Zibby Cloud. Returns the trigger URL.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workflow name to deploy' },
          projectId: { type: 'string', description: 'Target project ID' },
        },
        required: ['name', 'projectId'],
      },
    },
    {
      name: 'list_workflows',
      description: 'List all local workflows in .zibby/workflows/.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'explore_framework_docs',
      description: 'Read Zibby framework documentation on demand. Call this before building complex workflows or when you need details on advanced patterns (middleware, conditional routing, skills, deployment, CLI commands).',
      input_schema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Doc topic to read (e.g., "workflow", "custom-workflows", "cli-reference", "packages/core", "packages/skills", "integrations/jira"). Call with no topic to list all available docs.',
          },
        },
      },
    },
  ],

  async handleToolCall(name, args, context) {
    const cwd = context?.options?.workspace || process.cwd();

    try {
      switch (name) {
        case 'design_workflow': return await handleDesignWorkflow(args);
        case 'build_workflow': return await handleBuildWorkflow(args, cwd);
        case 'add_node': return await handleAddNode(args, cwd);
        case 'deploy_workflow': return await handleDeployWorkflow(args, cwd);
        case 'list_workflows': return handleListWorkflows(cwd);
        case 'explore_framework_docs': {
          const topic = (args.topic || '').trim();
          if (!topic) {
            const available = listAvailableDocs();
            return JSON.stringify({ available, hint: 'Call again with a topic to read its content.' });
          }
          const content = readDoc(topic);
          if (!content) {
            const available = listAvailableDocs();
            return JSON.stringify({ error: `Doc "${topic}" not found.`, available });
          }
          return JSON.stringify({ topic, content });
        }
        default: return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  resolve() {
    return null;
  },
};
