# Independent Claude review

When an independent review is useful, call `claude_ask` with the absolute project
directory and a focused task. Save the returned `session_id`; use
`claude_followup` to discuss findings or re-check fixes on that conversation.
Evaluate findings before applying them. Stop after three review rounds unless
the user requests more. Do not ask Claude to delegate back to Codex.

The bridge does not enforce read-only access. Use `permission_mode: "plan"`
for analysis-oriented sessions, or select an appropriate mode for implementation.
Only select `bypassPermissions` when the user has authorized that access.
