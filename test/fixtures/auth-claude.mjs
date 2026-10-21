import { writeFileSync } from 'node:fs';
const scenario = process.env.AUTH_SCENARIO;
if (process.env.AUTH_CAPTURE) writeFileSync(process.env.AUTH_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), home: process.env.CLAUDE_CONFIG_DIR,
  nesting: process.env.CLAUDECODE ?? null, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
  key: process.env.ANTHROPIC_API_KEY, cwd: process.cwd(), pid: process.pid,
}));
if (scenario === 'hang') setInterval(() => {}, 1000);
else if (scenario === 'oversize') console.log('x'.repeat(100000));
else if (scenario === 'malformed') { console.error('PRIVATE STDERR'); console.log('unsupported command PRIVATE'); process.exitCode = 1; }
else if (scenario === 'missing') console.log(JSON.stringify({ email: 'private@example.test' }));
else {
  console.log(JSON.stringify({ loggedIn: scenario !== 'logged-out', authMethod: 'claude.ai', email: 'private@example.test', accessToken: 'SECRET', organization: 'PRIVATE' }));
  if (scenario === 'logged-out' || scenario === 'failed') process.exitCode = 1;
}
