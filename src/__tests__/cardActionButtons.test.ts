/**
 * A BUTTON ON AN AGENT'S CARD CAN CARRY AN ACTION THE PLATFORM DOES ITSELF.
 *
 * `needs_you` puts a card with the agent's own choices in front of a person.
 * A choice was only ever words back to the agent — so an agent that needed a
 * folder on the owner's computer added to the project could ask, and the
 * owner's "yes" added nothing. The platform now keeps ONE closed list of what
 * a button can do; a card's event carries, per button that does something,
 * `optionActions: [{ option, action, args }]`, and the owner's click runs it
 * with the RECORDED arguments.
 *
 * Held here, over a mocked door (no network, no platform):
 *   1. `needs_you` takes `optionActions` and its description states the FACTS:
 *      what an action button is, and every entry of the list with its
 *      arguments — read off this package's one copy of the list (cardActions.ts);
 *   2. it passes what it was given to the card's event UNCHANGED — it checks
 *      nothing of it; the platform's refusal comes back as its own sentence,
 *      and no card is raised;
 *   3. 🔗 TWO-PLACES — the copy of the list is held to the platform's own
 *      (backend/src/services/card-actions.js), loaded for real when the
 *      sibling checkout has it. A standalone clone of this public repo, or a
 *      checkout whose backend does not have the list yet, reports the pin as
 *      SKIPPED, never as passed. `CARD_ACTIONS_BACKEND_DIR` names another
 *      backend to check against; a named one that lacks the file FAILS.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const door = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../lib/http-deadline.js', () => ({ fetchWithDeadline: door.fetch }));

Object.assign(process.env, {
  PROJECT_API_TOKEN: 'contract-test-placeholder', // deliberately NOT credential-shaped (public repo)
  ZIBBY_ACCOUNT_API_URL: 'http://cp.local',
  EXECUTION_ID: 'exec-self-0001',
  PROJECT_ID: 'proj-1',
  WORKFLOW_TYPE: 'developer',
});

const { agentMessagingSkill } = await import('../agentMessaging.js');
const cardActions = await import('../cardActions.js');

const call = (name: string, args: any = {}) => agentMessagingSkill.handleToolCall(name, args).then(JSON.parse);
const tool = (name: string) => agentMessagingSkill.tools.find((t: any) => t.name === name) as any;

let seen: Array<{ url: string; body: any }>;
/** The platform's door for a card: takes it, or answers with the refusal a test gives. */
function platform(refusal?: string) {
  door.fetch.mockImplementation(async (url: string, init: any) => {
    seen.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return refusal
      ? { ok: false, status: 400, json: async () => ({ error: refusal }), text: async () => JSON.stringify({ error: refusal }) }
      : { ok: true, status: 201, json: async () => ({ ok: true, id: 'events:1-a', routed: 'person' }), text: async () => '' };
  });
}
beforeEach(() => { seen = []; door.fetch.mockReset(); process.env.WORKFLOW_UUID = 'uuid-self'; });
afterEach(() => { delete process.env.WORKFLOW_UUID; });

const FOLDER = '/Users/sam/Projects/acme/packages/skills';
const TEXT = 'The chat tools live in packages/skills, and I cannot open that folder. May I read and change files there?';
const OPTIONS = ['Let the team edit it', 'Not now'];
const ACTIONS = [{ option: 'Let the team edit it', action: 'project_folder', args: { path: FOLDER, access: 'editable' } }];

describe('needs_you says what a button can do — as facts, from the one list', () => {
  const input = () => tool('needs_you').input_schema.properties.optionActions;

  it('takes `optionActions`, never required, in the platform\'s own shape: for each button that does something, { option, action, args }', () => {
    expect(input(), 'needs_you has no optionActions input').toBeTruthy();
    expect(tool('needs_you').input_schema.required).toEqual(['text', 'options']);
    expect(input().type).toBe('array');
    expect(Object.keys(input().items.properties)).toEqual(['option', 'action', 'args']);
    expect(input().items.required).toEqual(['option', 'action', 'args']);
    // The arguments are a name → text map the TOOL does not close: which names an action takes is the platform's list to say.
    expect(input().items.properties.args).toMatchObject({ type: 'object', additionalProperties: { type: 'string' } });
    expect(input().items.properties.action).not.toHaveProperty('enum');
    expect(input()).toEqual(cardActions.OPTION_ACTIONS_INPUT);
    expect(cardActions.OPTION_ACTIONS_FIELD).toBe('optionActions');
  });

  it('states what an action button is: the platform does it on the project owner\'s click, with the recorded arguments, and says what happened — words never do it', () => {
    const said = input().description;
    expect(said).toMatch(/plain choice/);
    expect(said).toMatch(/the platform itself does every one of them/);
    expect(said).toMatch(/project owner clicks/);
    expect(said).toMatch(/exactly the arguments you record/);
    expect(said).toMatch(/message saying, action by action, what was done and what was not and why/);
    expect(said).toMatch(/Nothing anyone types or says does any of it/);
    // The whole shape is in the WORDS too: bin/mcp-skill.mjs shows the model only an input's type and description.
    for (const key of ['option', 'action', 'args']) expect(said).toContain(`\`${key}\``);
    expect(said).toMatch(/`multi`\) cannot carry one/);
  });

  // A/B: before, the input said "A button with one carries an action" and "One entry per button that does
  // something" — an agent that needed several things granted was told a button holds one.
  it('states that a button carries ONE ACTION OR SEVERAL, all done on the one click, each reported — and never "one per button"', () => {
    const said = input().description;
    expect(said).toMatch(/A button with entries carries their actions, one or several/);
    expect(said).toMatch(/One entry per action/);
    expect(said).toMatch(/entries that name the same button are all that button's/);
    expect(said).toMatch(/Before the click the card shows the owner the platform's own sentence for everything that button does/);
    expect(said).not.toMatch(/One entry per button/i);
    expect(said).not.toMatch(/carries an action:/);
    expect(tool('needs_you').description).toMatch(/unless you give it one or several actions/);
  });

  it('names every entry of the list with what it is and every argument with what it means', () => {
    const said = input().description;
    expect(cardActions.CARD_ACTIONS.length).toBeGreaterThan(0);
    for (const entry of cardActions.CARD_ACTIONS) {
      expect(said, entry.name).toContain(entry.name);
      expect(said, entry.name).toContain(entry.what);
      for (const [name, arg] of Object.entries(entry.args)) {
        expect(said, `${entry.name}.${name}`).toContain(`${name} = ${arg.about}`);
        for (const value of arg.oneOf || []) expect(said, `${entry.name}.${name}`).toContain(`"${value}"`);
      }
    }
    // Derived, not typed: an entry added to the list is in the words.
    const more = [...cardActions.CARD_ACTIONS, { name: 'open_door', what: 'Open the door.', args: { which: { type: 'string' as const, about: 'which door', oneOf: ['front', 'back'] } } }];
    expect(cardActions.cardActionsSaid(more)).toMatch(/open_door — Open the door\. args: which = which door \("front" or "back"\)/);
  });

  it('the tool\'s own description says a choice can carry an action, and names the entries from the same list', () => {
    const said = tool('needs_you').description;
    expect(said).toContain('`optionActions`');
    expect(said).toMatch(/the platform itself does those when the project owner clicks it/);
    for (const entry of cardActions.CARD_ACTIONS) expect(said).toContain(entry.name);
  });

  it('the folder-request tool no longer says a card\'s choice can never give access: one that carries the folder action does, on the owner\'s click', () => {
    const said = tool('request_local_folder').description;
    expect(cardActions.CARD_ACTIONS.map((e) => e.name)).toContain(cardActions.FOLDER_ACTION);
    expect(said).toContain(`a needs_you button grants it only when you gave it the ${cardActions.FOLDER_ACTION} action, once for each folder that click is to add, and then by the owner's click`);
    // What it said before still holds for words: nothing anyone SAYS grants access.
    expect(said).toMatch(/Nothing you or anyone says grants access — not a needs_you choice, not a chat message/);
  });
});

describe('needs_you records what it was given — it checks nothing of an action itself', () => {
  it('the card\'s event carries the action exactly as given, beside the choices', async () => {
    platform();
    const out = await call('needs_you', { text: TEXT, options: OPTIONS, optionActions: ACTIONS, ticketKey: '610' });
    expect(out).toMatchObject({ ok: true, to: 'person', cardId: 'events:1-a' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://cp.local/projects/proj-1/events');
    expect(seen[0].body.kind).toBe('needs_human');
    expect(seen[0].body.data).toEqual({ question: TEXT, options: OPTIONS, ticketKey: '610', optionActions: ACTIONS });
  });

  it.each([
    ['a name that is not on the list', [{ option: 'Let the team edit it', action: 'run_shell', args: { command: 'ls' } }]],
    ['an argument the action does not take, and one missing', [{ option: 'Let the team edit it', action: 'project_folder', args: { path: FOLDER, mode: 'rw' } }]],
    ['a button that is not one of the choices', [{ option: 'Yes', action: 'local_app', args: { address: 'http://localhost:5173' } }]],
    ['a field the record does not have', [{ option: 'Not now', action: 'local_app', args: { address: 'http://localhost:5173' }, note: 'x' }]],
    ['not a list at all', 'project_folder'],
  ])('%s is sent as it is — refusing it is the platform\'s to do, in its words', async (_name, optionActions) => {
    platform();
    await call('needs_you', { text: TEXT, options: OPTIONS, optionActions });
    expect(seen).toHaveLength(1);
    expect(seen[0].body.data.optionActions).toEqual(optionActions);
  });

  it('several actions on ONE button are sent exactly as given, in order — one entry per action', async () => {
    platform();
    const three = ['agent-workflow', 'cli', 'core'].map((name) => ({ option: 'Let the team edit it', action: 'project_folder', args: { path: `/Users/sam/Projects/acme/packages/${name}`, access: 'editable' } }));
    await call('needs_you', { text: TEXT, options: OPTIONS, optionActions: three });
    expect(seen).toHaveLength(1);
    expect(seen[0].body.data.optionActions).toEqual(three);
  });

  it('together with `multi` it is still sent as it is: that the two do not go together is the platform\'s rule to say', async () => {
    platform();
    await call('needs_you', { text: TEXT, options: OPTIONS, multi: true, optionActions: ACTIONS });
    expect(seen[0].body.data).toMatchObject({ multi: true, optionActions: ACTIONS });
  });

  it('CONTROL — a card with no action is the card it was: no such field (left out, or given empty as a model fills an unused input)', async () => {
    for (const extra of [{}, { optionActions: undefined }, { optionActions: null }, { optionActions: [] }, { optionActions: '' }]) {
      seen = [];
      platform();
      await call('needs_you', { text: TEXT, options: OPTIONS, ...extra });
      expect(seen[0].body.data).toEqual({ question: TEXT, options: OPTIONS });
    }
  });

  it('the platform refuses the action: its sentence comes back, ONE request was made, and no card is in front of anyone', async () => {
    const sentence = '"run_shell" is not an action a button can carry. The list: project_folder (path, access), local_app (address).';
    platform(sentence);
    const out = await call('needs_you', { text: TEXT, options: OPTIONS, optionActions: [{ option: 'Let the team edit it', action: 'run_shell', args: {} }] });
    expect(seen).toHaveLength(1);
    expect(seen[0].body.data.optionActions).toEqual([{ option: 'Let the team edit it', action: 'run_shell', args: {} }]);
    expect(out.error).toContain('is not an action a button can carry');
    expect(out.error).toContain('project_folder (path, access), local_app (address)');
    expect(out).not.toHaveProperty('ok');
    expect(out).not.toHaveProperty('cardId');
  });
});

/**
 * 🔗 TWO-PLACES — the list is the platform's (backend/src/services/card-actions.js)
 * and this skill cannot import it. When the checkout is present its module is
 * loaded and `cardActionCatalog()` — its one declaration — is compared with
 * what this package tells an agent.
 */
describe('contract pin: card-actions.js — the list an agent is told is the platform\'s list', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const named = process.env.CARD_ACTIONS_BACKEND_DIR || '';
  const backend = resolve(named || join(here, '..', '..', '..', '..', 'backend'));
  const file = join(backend, 'src', 'services', 'card-actions.js');
  const present = existsSync(file);
  const pin = it.skipIf(!present && !named);
  const platformList = () => createRequire(import.meta.url)(file);
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

  pin('the platform\'s list is where it was looked for', () => {
    expect(present, `no card-actions.js at ${file}`).toBe(true);
  });

  pin('entry for entry, argument for argument: name, what it is, type, fixed values', () => {
    const theirs = platformList().cardActionCatalog().map(({ name, what, args }: any) => ({ name, what, args }));
    expect(plain(cardActions.CARD_ACTIONS)).toEqual(theirs);
  });

  pin('what the description says of every entry is true of each: the project owner clicks it, the platform does it', () => {
    expect(cardActions.OPTION_ACTIONS_INPUT.description).toMatch(/project owner clicks it the platform itself does every one of them/);
    for (const entry of platformList().cardActionCatalog()) {
      expect(entry.clicker, `${entry.name} is clicked by someone else — the description says the project owner`).toBe('project-owner');
      expect(entry.runs, `${entry.name} runs somewhere else — the description says the platform does it`).toBe('platform');
    }
  });

  pin('the record: the field\'s name and its three keys are the platform\'s', () => {
    const src = readFileSync(file, 'utf-8');
    expect(cardActions.OPTION_ACTIONS_FIELD).toBe(platformList().OPTION_ACTIONS_FIELD);
    const keys = /const RECORD_KEYS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
    expect(keys, 'RECORD_KEYS must be declared in card-actions.js').toBeTruthy();
    expect(keys![1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))).toEqual(Object.keys(cardActions.OPTION_ACTIONS_INPUT.items.properties));
  });

  // 🔗 TWO-PLACES: the description tells an agent a button carries one action or several. Against a platform that
  // takes one per button this FAILS — the agent would be told something the platform refuses.
  pin('several entries that name ONE button are taken by the platform as written, and its one sentence for that button says all of them', () => {
    expect(cardActions.OPTION_ACTIONS_INPUT.description).toMatch(/entries that name the same button are all that button's/);
    const p = platformList();
    const capabilities = Object.fromEntries(Object.values(p._test.LIST).map((e: any) => [e.capability, true]));
    const folders = ['agent-workflow', 'cli', 'core'].map((name) => `/Users/sam/Projects/acme/packages/${name}`);
    const record = folders.map((path) => ({ option: 'Yes, all of it', action: 'project_folder', args: { path, access: 'editable' } }));
    const options = ['Yes, all of it', 'Not now'];
    expect(p.validateOptionActions(record, options, { capabilities })).toEqual({ ok: true, value: record });
    const shown = p.describeOptionActions({ options, optionActions: record });
    expect(shown).toHaveLength(1);
    for (const path of folders) expect(shown[0].does).toContain(path);
  });

  pin('a card whose choices are picked together cannot carry an action — as the input\'s description says', () => {
    const format = join(backend, 'src', 'services', 'project-events-format.js');
    expect(existsSync(format), `no project-events-format.js at ${format}`).toBe(true);
    expect(readFileSync(format, 'utf-8')).toMatch(/if \(out\.multi === true\) return \{ ok: false, error: 'a card whose choices are picked together \(multi\) cannot carry an action/);
  });
});
