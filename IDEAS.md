# Ideas

## Background Claude completion notification

Explore an optional interactive background mode: start Claude with `claude_start`,
let Codex continue other work, and have the live card notify the conversation
when the run finishes. The notification could ask the model to call `claude_wait`
with the run ID to retrieve the final result.

MCP Apps defines `ui/message`, which a card can use to request a message in the
host conversation. Test this in Codex desktop before relying on it:

- Check whether the host advertises and accepts `ui/message`, including messages
  sent automatically rather than in response to a user action.
- Check whether completion starts or queues a model turn while Codex is busy or
  idle, and how the message appears to the user; the protocol uses a user role.
- Check what happens when the card is hidden, recreated, or torn down before
  completion, and avoid duplicate notifications on replays.

Keep `claude_wait` as the fallback when notification is unsupported, rejected,
or cannot be delivered. This is an idea for later, not an implemented feature.

Reference: [MCP Apps sendMessage](https://apps.extensions.modelcontextprotocol.io/api/classes/app.App.html).
