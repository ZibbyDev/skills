/**
 * agent-messaging's and chat-progress's tools accept exactly what they accepted
 * before their descriptions were shortened to facts. One definition serves every
 * agent that declares these skills, so this holds for all of them.
 *
 *   1. the same tools by name;
 *   2. each tool's argument contract with descriptions removed (types, enums,
 *      required fields, bounds, nesting) identical to the one recorded before
 *      the change (fixtures/tool-contracts/before.json);
 *   3. recorded calls from real runs and probes derived from each schema before
 *      the change are accepted or refused exactly as they were.
 *
 * A deliberate contract change regenerates the fixture in the same commit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { agentMessagingSkill } from '../agentMessaging.js';
import { chatProgressSkill } from '../chatProgress.js';
import { skeleton, accepts } from './fixtures/tool-contracts/schema-skeleton.js';

const before = JSON.parse(readFileSync(new URL('./fixtures/tool-contracts/before.json', import.meta.url), 'utf8'));
const servers: Record<string, any[]> = { agent_messaging: agentMessagingSkill.tools, chat_progress: chatProgressSkill.tools };
const schemaOf = (server: string, tool: string) => servers[server].find((t) => t.name === tool)?.input_schema;

describe('tool contracts are unchanged by the wording', () => {
  it('serves the same tools', () => {
    for (const [server, tools] of Object.entries(servers)) expect(tools.map((t) => t.name).sort(), server).toEqual(Object.keys(before.skeletons[server]).sort());
  });
  it('keeps every argument contract identical once descriptions are removed', () => {
    for (const [server, tools] of Object.entries(servers)) for (const t of tools) expect(skeleton(t.input_schema), `${server}/${t.name}`).toEqual(before.skeletons[server][t.name]);
  });
  it('accepts and refuses the recorded and probe calls exactly as before', () => {
    expect(before.calls.filter((c: any) => c.source === 'recorded').length).toBeGreaterThan(20);
    expect(before.calls.some((c: any) => c.accepted) && before.calls.some((c: any) => !c.accepted)).toBe(true);
    const differ = before.calls.filter((c: any) => accepts(schemaOf(c.server, c.tool), c.args) !== c.accepted).map((c: any) => `${c.server}/${c.tool} ${JSON.stringify(c.args).slice(0, 160)}`);
    expect(differ).toEqual([]);
  });
});
