## bash tool: `description` is required

The `bash` tool's schema requires a `description` parameter (a short, 5-10 word summary of what the command does) alongside `command` — even though it is not always shown to you as required. Omitting it fails the call with a schema validation error before the command ever runs.

Correct: `bash(command="ls -la", description="List current directory files")`
Wrong: `bash(command="ls -la")` — fails with `description: Invalid input: expected string, received undefined`

Always include `description` on every `bash` call.
