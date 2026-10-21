// A protocol-level substitute for Claude; deliberately never loads user configuration.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const value = flag => args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
  ?? (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const session = value('--session-id') ?? value('--resume');
const request = {
  args, prompt, cwd: process.cwd(), session, pid: process.pid,
  resumed: args.some(arg => arg.startsWith('--resume=')),
  home: process.env.CLAUDE_CONFIG_DIR,
  nesting: process.env.CLAUDECODE ?? null,
  entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
};
appendFileSync(process.env.INTEGRATION_CALL_LOG, JSON.stringify(request) + '\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
if (prompt === '__hang_until_cancelled__') {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (prompt === '__generic_failure__' || prompt === '__authentication_failure__') {
  const error = prompt === '__authentication_failure__' ? 'Invalid API key' : 'Requested model is unavailable';
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', session_id: session, is_error: true, errors: [error] }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: session, is_error: false, result: JSON.stringify(request) }));
}
