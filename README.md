# codex-claude-mcp

A local stdio MCP server that lets Codex ask Claude Code for an independent
opinion or delegate a task, then follow up on the same Claude conversation.
Adapted from `cc-codex-mcp` by NtTestAlert (MIT).

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
npm install
npm run build
node dist/index.js --doctor
```

Doctor resolves the executable, validates the isolated home and syncs configuration.
It does not make a model call or verify authentication. It prints the login command.
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
project instructions. This repository is local; no GitHub remote is required.

## Tools

Both tools accept `prompt`, optional `model`, optional `effort`
(`low`, `medium`, `high`, `xhigh`, `max`) and `timeout_sec` (10–3600, default 900).
Model/effort support is validated by Claude itself; values are not translated
from Codex reasoning levels.

`claude_ask` also requires `cwd` and accepts `permission_mode`: `default`
(the default), `acceptEdits`, `plan`, `dontAsk`, or `bypassPermissions`.
Noninteractive calls cannot display interactive approvals: operations requiring
approval may be denied. `bypassPermissions` explicitly opts out of Claude's
permission prompts. It is not enabled automatically.

`claude_followup` requires `session_id` from an earlier ask. It restores the
session's cwd and permission mode; optional model/effort overrides persist in
bridge metadata. A missing cwd is an error, never a fallback to another project.
Different sessions can run concurrently; calls on the same session are serialized.

Results contain `session_id`, `answer`, `duration_sec`, `warnings`, `activity`,
and, when applicable, `error` and `answer_file`. Errors are also MCP tool errors.
Interrupted calls retain their bridge ID, but resuming is possible only if Claude
created its underlying transcript before interruption. Long answers are retained
in a temporary file; callers are responsible for removing retained answer files.

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
home. Calls use private temporary configuration snapshots, removed after the run.
Remote MCP OAuth connections may require separate login in that home.

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
Windows is the primary target. POSIX process-group cleanup is implemented but
requires validation on macOS/Linux. As in the original bridge, a parent crash
before cleanup can leave a grandchild behind on Windows (no Job Object).

Roadmap: enforced read-only profile, broader platform validation, configuration
watching (currently refreshed per call), and optional asynchronous job tools.
