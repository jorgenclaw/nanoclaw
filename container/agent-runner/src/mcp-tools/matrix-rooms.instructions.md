## Matrix rooms (`create_matrix_room`)

`mcp__nanoclaw__create_matrix_room({ name, topic, invite, agent })` asks for a new private Matrix room. **Scott approves every request** with a card, so only ask when a room is really needed.

### The fields

- `name` (required) — the room's name as Scott sees it in Element X. Max 80 characters.
- `topic` — optional one-line description.
- `invite` — optional list of Matrix user ids, like `@scott:matrix.jorgenclaw.ai`. **Leave it out** to invite Scott. Never invite anyone else unless Scott told you to.
- `agent` — optional. Leave it out and the room is **yours**: whatever is written there reaches you. To make a room for a sub-agent you created, pass its name (the name you use with `send_message`). A sub-agent needs a Matrix account of its own first; if it has none, you are told and nothing is created.

### What happens next

1. You get "Asked for the room…" straight away. That is not the room yet.
2. Scott gets an approval card. If he says no, you are told. If he says yes, the room is created and Scott is invited.
3. You get a report when the room exists. It is only a report: **do not post in the room yourself**.
4. Scott must accept the invite in Element X before he can write in the room. After that, whatever he writes there reaches you as its own conversation, and your reply to it goes back to that room.
5. **Keep answering every message in the conversation it came from.** A new room changes nothing about where you answer Scott's other chats. If Scott writes to you in his direct chat, answer in the direct chat, never inside a room. Post into a room only when Scott asks you to (the report names its destination for that case).

### A room for a sub-agent: you are a quiet member

When you pass `agent`, you are invited and join that room too, in addition to Scott and the sub-agent:

- **The sub-agent answers Scott.** It answers everything written in the room except a message that **starts with your name** (for example "jorgenclaw, what did I ask coder?", "@jorgenclaw status?").
- **You only hear messages that start with your name.** Everything else in the room is kept as background and you do not answer it. When one does reach you, answer it in that room.
- **Never post there on your own.** Use the room's destination only when Scott asks you to.
- **Delegating work is unchanged.** Give the sub-agent a task with `send_message({ to: "<its name>" })`, not through the room. Its reply comes back to you the same way.

### Good to know

- Rooms are plain (not encrypted) on purpose. You cannot read encrypted rooms.
- Each room is its own conversation with its own memory. Do not assume you remember what was said in Scott's direct chat.
- Do not create a room that already exists, and do not create rooms for one-off questions.
- This tool cannot rename, delete, or leave a room. Ask Scott if a room needs to go.
- Never ask Scott for a password or any login to do this. You do not need one.
