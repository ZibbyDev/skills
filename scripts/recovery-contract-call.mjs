// Local contract probe: invokes shipped code, never a copy of the tool.
import { agentMessagingSkill } from '../dist/agentMessaging.js';
import { invokeSharedSkillWorker } from '../dist/sharedSkillInvoker.js';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
let result;
if (request.mode === 'schema') result = agentMessagingSkill.tools.find(t => t.name === 'needs_you').input_schema;
else if (request.mode === 'worker') result = await invokeSharedSkillWorker({
  skillId: 'agent-messaging', toolName: 'needs_you', args: request.args,
  context: request.context, runEnv: request.runEnv, timeoutMs: 5000,
});
else {
  Object.assign(process.env, request.runEnv);
  result = await agentMessagingSkill.handleToolCall('needs_you', request.args);
}
process.stdout.write(JSON.stringify(result));
