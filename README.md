# codex-claude-mcp

A local stdio MCP server that lets Codex ask Claude Code for an independent
opinion or delegate a task, then follow up on the same Claude conversation.
Adapted from [cc-codex-mcp](https://github.com/NtTestAlert/cc-codex-mcp) by NtTestAlert (MIT).

- `claude_ask`: start a session in a project directory.
- `claude_followup`: resume an explicit bridge-owned session.
- Isolated `CLAUDE_CONFIG_DIR` (default `~/.claude-reviews`). Claude login credentials are never copied.
- Per-call subprocesses, cross-process session locks, progress, timeout/cancellation
  with process-tree cleanup, partial results and large-answer files.
- No enforced read-only sandbox. Claude's permission mode is selected on session
  creation and preserved on follow-up. Read-only enforcement is on the roadmap.

## Setup

Requires Node.js >=20.3 and a separately installed Claude Code CLI. The initial
compatibility baseline is Claude Code 2.1.277. Use your existing Claude Code
authentication method; the isolated configuration needs its own login.

```sh
git clone https://github.com/NtTestAlert/codex-claude-mcp.git
cd codex-claude-mcp
npm install
npm run build
node dist/index.js --doctor
```

Doctor resolves the executable, validates the isolated home, syncs configuration,
and checks `claude auth status --json` in that home. It makes no model call and
reports only authentication status/method, not account details. It prints the login command.
`node dist/index.js --auth-status` checks authentication alone (exit 0 authenticated,
1 unauthenticated, 2 unknown/check failed). Doctor stays usable before login.
On Windows, `powershell -File scripts/login.ps1` performs that login. On POSIX:

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-reviews" claude auth login
```

Add to Codex's `config.toml`, using absolute paths (a real Node executable is
recommended on Windows to avoid version-manager shim behavior):

```toml
[mcp_servers.claude]
command = "C:/path/to/node.exe"
args = ["C:/path/to/codex-claude-mcp/dist/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 3700
```

Restart the Codex session after registration. See `AGENTS.snippet.md` for optional
project instructions.

## Tools

Both tools accept `prompt`, optional `model`, optional `effort`
(`low`, `medium`, `high`, `xhigh`, `max`) and `timeout_sec` (10–3600, default 900).
Model/effort support is validated by Claude itself; values are not translated
from Codex reasoning levels.

`claude_ask` also requires `cwd` and accepts `permission_mode`: `manual`
(the default), `default` (legacy alias for manual), `acceptEdits`, `auto`, `plan`,
`dontAsk`, or `bypassPermissions`. Claude itself enforces model/account availability
and organization policy for auto mode.
Noninteractive calls cannot display interactive approvals: operations requiring
approval may be denied. `bypassPermissions` explicitly opts out of Claude's
permission prompts. It is not enabled automatically.

Optional `allowed_tools` supplies explicit Claude permission rules at session
creation, for example `["Bash(git diff *)", "Bash(git status *)"]`. These are
preserved on follow-ups and restart. They pre-approve matching actions; they do
not restrict tool visibility or enforce read-only access. No rules are granted
implicitly. Do not rely on Claude's built-in read-only command checks: the live
manual-mode test denied our Git diff command without an explicit allow rule.
Organization denies and other Claude policy still apply.

`claude_followup` requires `session_id` from an earlier ask. It restores the
session's cwd, permission mode and explicit tool rules; optional model/effort
overrides persist in bridge metadata. These overrides intentionally change that
session's subsequent defaults; pass another override to change them again.
A missing cwd is an error, never a fallback to another project.
Different sessions can run concurrently; calls on the same session are serialized.

Results contain `session_id`, `answer`, `duration_sec`, `warnings`, `activity`,
and, when applicable, `error` and `answer_file`. Errors are also MCP tool errors.
Interrupted calls retain their bridge ID, but resuming is possible only if Claude
created its underlying transcript before interruption. Long answers are retained
in a temporary file; callers are responsible for removing retained answer files.

Example result (illustrative):

```json
{
  "session_id": "7c280530-f6b8-4cc7-8759-929966932dfa",
  "answer": "The change replaces addition with subtraction.",
  "duration_sec": 8.2,
  "warnings": ["MCP server documentation startup failed"],
  "activity": { "commands": 1, "mcp_tool_calls": [], "subagent_events": 0 }
}
```

MCP startup failures and authentication-required statuses in Claude's init events
are reported in warnings even when stderr is empty. Error payloads that may
contain configuration secrets are omitted from these startup warnings. Login
advice is attached only to errors recognized as authentication failures.

### Timeouts

`timeout_sec` is the bridge's call budget, including waiting for a session lock.
On timeout, cancellation, shutdown, or client stdin EOF the active process tree
is terminated. Cleanup can take a few additional seconds. Codex's
`tool_timeout_sec` is a separate outer deadline: 3700 seconds accommodates the
bridge's maximum 3600-second run plus cleanup. Progress notifications give
visibility; they are not assumed to extend Codex's deadline.

## Configuration and isolation

| Variable | Meaning |
|---|---|
| `CLAUDE_BRIDGE_HOME` | Isolated config/state directory; default `~/.claude-reviews` |
| `CLAUDE_BRIDGE_SOURCE_HOME` | Source Claude directory; otherwise inherited `CLAUDE_CONFIG_DIR` or `~/.claude` |
| `CLAUDE_BRIDGE_CLAUDE_PATH` | Explicit Claude executable or supported npm shim/JS entrypoint |
| `CLAUDE_BRIDGE_MCP_EXCLUDE` | Comma-separated source MCP server names to omit |

Before every run the bridge refreshes generated settings and MCP configuration.
It inherits the source model/effort and eligible user MCP servers, excluding both
bridge directions to avoid recursion. It never copies credentials, sessions,
hooks or permission settings. Source configuration is read-only. Generated files
from doctor and session metadata live under `.codex-claude-mcp` inside the isolated
home. Calls use separate configuration snapshots under
`<isolated home>/.codex-claude-mcp/runs/`, removed after the run, including when a
large answer file is retained. MCP configuration is no longer written to the
system-wide temporary directory. Re-reading config per call is deliberate for
freshness; each subprocess gets its own snapshot to avoid concurrent overwrite.

Remote MCP OAuth connections need their own authorization in the isolated home.
For a synced server named `documentation`, register its generated definition in
the isolated profile, then log in from an interactive terminal. Claude's MCP
management subcommands do not use the bridge's per-call `--mcp-config` file:

```powershell
node dist/index.js --doctor
$env:CLAUDE_CONFIG_DIR = "$HOME\.claude-reviews"
$config = Get-Content "$env:CLAUDE_CONFIG_DIR\.codex-claude-mcp\mcp.json" -Raw | ConvertFrom-Json
$entry = $config.mcpServers.documentation | ConvertTo-Json -Depth 100 -Compress
claude mcp add-json --scope user documentation $entry
claude mcp login documentation
```

On POSIX (using `jq` to extract the definition):

```sh
export CLAUDE_CONFIG_DIR="$HOME/.claude-reviews"
entry=$(jq -c '.mcpServers.documentation' "$CLAUDE_CONFIG_DIR/.codex-claude-mcp/mcp.json")
claude mcp add-json --scope user documentation "$entry"
claude mcp login documentation
```

Use your configured bridge home if it differs from the default. Doctor generates
the referenced file without modifying the source configuration.
Skip add-json if this server is already registered in the isolated profile.
For headless terminals, `claude mcp login --no-browser documentation` prints the
authorization URL instead of launching a browser.

Claude still loads applicable project instructions/settings according to its own
rules. Configuration isolation is not filesystem sandboxing. The bridge passes
an explicit MCP configuration with `--strict-mcp-config` instead of automatically
loading project MCP servers. Parent environment credentials remain available to
Claude; an API key can select API billing rather than subscription authentication.

## Development

```sh
npm test
```

Tests use temporary directories and fake Claude processes, not paid model calls.
The explicit `npm run test:live` command makes two real Claude calls using the
isolated login: a review of a disposable Git diff and a follow-up after fixing it.
It uses manual mode with the explicit `Bash(git diff *)` allowance and no permission
bypass. Add `--without-allow-rules` to reproduce the baseline permission check. Use
`npm run test:live -- --permission-mode=plan` to check plan mode separately.
The default live-test model is `sonnet`; `CLAUDE_BRIDGE_LIVE_MODEL` overrides it.
Live transcripts stay in the isolated profile; the disposable project is removed.
Windows is the primary target. POSIX process-group cleanup is implemented but
requires validation on macOS/Linux. As in the original bridge, a parent crash
before cleanup can leave a grandchild behind on Windows (no Job Object).

Roadmap: enforced read-only profile, broader platform validation, configuration
watching (currently refreshed per call), and optional asynchronous job tools.

## Verification record

Checked against installed Claude Code 2.1.277: print mode, stream-json output,
explicit session IDs and resume, model/effort flags, manual/auto permission modes,
allowedTools, strict MCP config, and `auth status --json`. Automated tests exercise
the real MCP transport against fake Claude subprocesses, including restart,
EOF cancellation, permission-rule persistence, startup diagnostics and auth checks.

Live checks on Windows, 2026-10-21, Claude Code 2.1.277, `sonnet`, low effort:

| Check | Result |
|---|---|
| Isolated-profile `auth status --json` | Authenticated after separate login |
| Manual review without allow rules | Git diff denied; surfaced as `Permission denied: Bash` |
| Manual review with `Bash(git diff *)` | Git diff ran and regression identified; same-session follow-up confirmed fix (15.1s / 14.1s) |
| Plan review with `Bash(git diff *)` | Git diff ran and regression identified; same-session follow-up confirmed fix (14.8s / 13.4s) |

These tests used a disposable staged Git fixture, no permission bypass, and an
empty source MCP config to keep the check focused on local Git access. They do
not certify every synced MCP server or a production repository's policies.
Automated suite: 52 passed, 1 platform-specific skip.
