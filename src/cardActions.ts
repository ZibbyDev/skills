/**
 * cardActions.ts — WHAT A BUTTON ON A CARD CAN DO, AS AN AGENT IS TOLD IT.
 *
 * A card's button (`needs_you` options) is a plain choice — the person's
 * answer, which the agent reads — or it CARRIES AN ACTION: a platform call
 * whose name and arguments are RECORDED on the card when it is raised, and
 * which the platform itself runs when the project owner clicks that button.
 * Nothing typed or said runs it.
 *
 * THE LIST IS THE PLATFORM'S, AND CLOSED (backend
 * src/services/card-actions.js — `cardActionCatalog()` is its one
 * declaration). An agent picks an entry by name; it cannot define one. This
 * file is NOT that list: it is what an agent is TOLD of it, in a tool's input
 * description, because this package cannot import the platform's code.
 * 🔗 TWO-PLACES — held equal to the platform's list, entry for entry and
 * argument for argument, by src/__tests__/cardActionButtons.test.ts ("contract
 * pin: card-actions.js"): it loads the platform's file when the sibling
 * checkout has it, and is reported as skipped — never passed — when it does not.
 *
 * NOTHING HERE VALIDATES. The platform's validator is the one place an action
 * is checked (when the card is raised, and again at the click); the tool that
 * takes this input passes it on as given, and a refusal comes back as the
 * platform's own sentence.
 */

/** The card event's field for what its buttons do — the platform's name for it. */
export const OPTION_ACTIONS_FIELD = 'optionActions';

export interface CardActionArg { type: 'string'; about: string; oneOf?: readonly string[] }
export interface CardActionEntry { name: string; what: string; args: Readonly<Record<string, CardActionArg>> }

/**
 * What a caller GAVE for the field, or undefined when it gave nothing: left
 * out, null, or empty the way a model fills an input it does not use ('' or
 * []). Anything else is passed on AS IT IS — well-formed or not; saying what
 * is wrong with it is the platform's. PURE.
 */
export const optionActionsGiven = (value: unknown): unknown => (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length) ? undefined : value);

const freeze = (entry: CardActionEntry): CardActionEntry => Object.freeze({
  ...entry,
  args: Object.freeze(Object.fromEntries(Object.entries(entry.args).map(([name, arg]) => [name, Object.freeze({ ...arg, ...(arg.oneOf ? { oneOf: Object.freeze([...arg.oneOf]) } : {}) })]))),
});

/**
 * The platform's entries, as its catalog gives them: the name an agent passes,
 * one line on what it is, and each argument it records (all text) with what it
 * means and, where the platform fixes them, its values.
 */
export const CARD_ACTIONS: readonly CardActionEntry[] = Object.freeze(([
  {
    name: 'project_folder',
    what: 'Add a folder on this computer to the project\'s folders, or change the access of one already there.',
    args: {
      path: { type: 'string', about: 'the folder\'s full path on this computer' },
      access: { type: 'string', about: 'what the project\'s agents may do in it', oneOf: ['read-only', 'editable'] },
    },
  },
  {
    name: 'local_app',
    what: 'Let the project\'s agents open an app running on this computer, at one address, in their browser.',
    args: {
      address: { type: 'string', about: 'the address the app answers on, like http://localhost:5173' },
    },
  },
] as CardActionEntry[]).map(freeze));

/** One argument as a tool description says it. PURE. */
const argSaid = ([name, arg]: [string, CardActionArg]): string => `${name} = ${arg.about}${arg.oneOf?.length ? ` (${arg.oneOf.map((v) => `"${v}"`).join(' or ')})` : ''}`;

/** The list in words: each entry's name, what it is and its arguments. PURE — derived, so an entry added to the list is in the words. */
export const cardActionsSaid = (list: readonly CardActionEntry[] = CARD_ACTIONS): string => list.map((e) => `${e.name} — ${e.what} args: ${Object.entries(e.args).map(argSaid).join('; ')}.`).join(' ');

/** The entries' names, for a sentence that only points at the input. PURE. */
export const cardActionNames = (list: readonly CardActionEntry[] = CARD_ACTIONS): string => list.map((e) => e.name).join(', ');

/** The entry that adds a folder — named where another tool's description points at it. Its presence on the list is what the pin holds. */
export const FOLDER_ACTION = 'project_folder';

/**
 * THE INPUT a tool that raises a card takes for it — the platform's own shape
 * (`optionActions: [{ option, action, args }]`), so what the model writes is
 * what the card's event carries, unchanged. The whole shape is in the
 * description's WORDS as well as in `items`: this package's tool server
 * (bin/mcp-skill.mjs) shows the model only an input's type and description.
 *
 * `action` carries no enum and `args` is an open name → text map on purpose:
 * closing them here would be a second validator, and a card raised against a
 * platform whose list has grown would be refused by this tool instead of
 * taken by the platform.
 */
export const OPTION_ACTIONS_INPUT = Object.freeze({
  type: 'array',
  items: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      option: Object.freeze({ type: 'string', description: 'the button this is about: its words, exactly as written in options' }),
      action: Object.freeze({ type: 'string', description: `the action's name on the platform's list (${cardActionNames()})` }),
      args: Object.freeze({ type: 'object', additionalProperties: Object.freeze({ type: 'string' }), description: 'that action\'s arguments, by name' }),
    }),
    required: Object.freeze(['option', 'action', 'args']),
  }),
  description: 'Optional: what a button DOES. A button with no entry here is a plain choice — the person\'s answer, for you to read. A button with one carries an action: when the project owner clicks it the platform itself does it, with exactly the arguments you record here, and sends you a message saying what was done or that it was not. Nothing anyone types or says does it — only that click. '
    + 'One entry per button that does something: { `option`: that button\'s words exactly as written in options, `action`: a name from the platform\'s list, `args`: { its arguments by name, as text } }. The platform\'s list: '
    + `${cardActionsSaid()} `
    + 'The platform checks each entry when the card is raised and says why it refuses one. A card whose choices are picked together (`multi`) cannot carry one.',
});
