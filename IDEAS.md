# Ideas

## Background Claude completion notification

The experimental `background` mode attempts a completion message from the live
MCP Apps card. It is disabled by default: Codex may queue the message until it
is stale, so delivery does not reliably provide useful background coordination.
Reconsider this design before relying on it:

- Check whether the host advertises and accepts text `ui/message`, including
  messages sent automatically rather than in response to a user action.
- Check whether completion starts or queues a model turn while Codex is busy or
  idle, and how the user-role message appears in the conversation.
- Check what happens when a card is hidden, recreated, or torn down. The bridge
  limits each run to one delivery attempt; `claude_wait` remains the fallback.
- Explore explicit status checks or host-native task completion mechanisms that
  do not inject queued user-role messages; verify host support first.

Reference: [MCP Apps sendMessage](https://apps.extensions.modelcontextprotocol.io/api/classes/app.App.html).
