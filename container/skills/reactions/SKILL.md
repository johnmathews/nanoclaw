---
name: reactions
description: Send and query emoji reactions on messages. Reactions you receive appear in conversation context automatically. Use tools to send reactions or query reaction history.
---

# Reactions

## Seeing reactions

Incoming reactions from users appear automatically in your conversation context as `<reactions>` annotations on messages. For example:

```xml
<message sender="Alice" time="Jan 1, 2:30 PM">great idea
  <reactions>👍 Bob; ❤️ Carol</reactions>
</message>
```

Reactions can also trigger your invocation — if a user reacts to a message, you may see a synthetic message like `[Reacted 👍 to "great idea"]`.

## Sending reactions

Use `mcp__nanoclaw__react_to_message` to react to messages.

### React to the latest message

```
mcp__nanoclaw__react_to_message(emoji: "👍")
```

### React to a specific message

```
mcp__nanoclaw__react_to_message(emoji: "❤️", message_id: "3EB0F4C9E7...")
```

### Remove a reaction

```
mcp__nanoclaw__react_to_message(emoji: "")
```

## Querying reactions

Use `mcp__nanoclaw__query_reactions` to search reaction history.

### All recent reactions

```
mcp__nanoclaw__query_reactions()
```

### Filter by emoji

```
mcp__nanoclaw__query_reactions(emoji: "👍")
```

### Filter by reactor

```
mcp__nanoclaw__query_reactions(reactor: "Alice")
```

### Reactions on a specific message

```
mcp__nanoclaw__query_reactions(message_id: "3EB0F4C9E7...")
```

## Common emoji

| Emoji | When to use |
|-------|-------------|
| 👍 | Acknowledgment, approval |
| ❤️ | Appreciation, love |
| 😂 | Something funny |
| 🔥 | Impressive, exciting |
| 🎉 | Celebration, congrats |
| 🙏 | Thanks, prayer |
| ✅ | Task done, confirmed |
| ❓ | Needs clarification |
