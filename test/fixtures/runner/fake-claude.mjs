import { spawn } from 'node:child_process';
import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (process.env.FAKE_CHILD_FILE) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  fs.writeFileSync(process.env.FAKE_CHILD_FILE, String(child.pid));
}
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
const events = JSON.parse(process.env.FAKE_EVENTS ?? '[]');
const stream = events.map(e => JSON.stringify(e).replaceAll('$STDIN', JSON.stringify(input).slice(1, -1))).join('\n');
const bytes = Buffer.from(stream);
if (process.env.FAKE_CHUNKED) {
  for (let i = 0; i < bytes.length; i += 7) process.stdout.write(bytes.subarray(i, i + 7));
} else process.stdout.write(stream);
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
