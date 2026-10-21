# Independent Claude review

When an independent review is useful, call `claude_ask` with the absolute project
directory and a focused task. Save the returned `session_id`; use
`claude_followup` to discuss findings or re-check fixes on that conversation.
Evaluate findings before applying them. Stop after three review rounds unless
the user requests more. Do not ask Claude to delegate back to Codex.

The bridge does not enforce read-only access. Use `permission_mode: "manual"`
for ordinary reviews. For Git reviews, pass `allowed_tools` with
`["Bash(git diff *)", "Bash(git status *)", "Bash(git log *)"]` to authorize those
commands noninteractively. Do not assume the isolated profile already allows them.
If a required command is denied, report the denial; do not claim the diff was
reviewed. Keep additional rules scoped to the requested task. Rules persist for
that session. `plan` is also
available for analysis, but is not a bridge-enforced sandbox.
Only select `bypassPermissions` when the user has authorized that access.
