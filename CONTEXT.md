# Context — opencode-advisor

Notes on motivation, design decisions, and opencode API discoveries made while building this plugin. Useful for contributors and for AI assistants picking up work on this repo.

---

## Motivation

The [advisor strategy](https://claude.com/blog/the-advisor-strategy) is an Anthropic-described pattern where a smaller model doing active work can escalate hard questions to a larger model. The key insight is that context should flow automatically from the harness — the working model shouldn't have to describe its own situation in the tool call, which wastes tokens and introduces summarization error.

opencode is a natural fit: it's an agentic coding tool where the working model has a full session history, and the plugin API gives access to that history programmatically.

---

## opencode plugin API — key discoveries

These were learned by reading opencode source at `packages/opencode/` rather than documentation, which is sparse.

### Plugin loading

opencode loads plugins from two places:
1. **`.opencode/plugins/*.ts`** — auto-loaded on startup, no config needed
2. **npm packages** — listed in `opencode.json` under `"plugins": ["package-name"]`

For npm packages, the entry point is resolved by `resolvePackageEntrypoint` in `packages/opencode/src/plugin/shared.ts`:
- First checks `package.json` `exports["./server"]`
- Falls back to `main`

The v1 plugin format (npm packages) expects:
```ts
export default { id: "plugin-id", server: Plugin }
```

A `Plugin` is `async ({ client, directory }) => { return { tool: {...}, hook: {...} } }`.

### opencode.json is strict

`opencode.json` is validated against a JSON Schema. **Unknown keys cause a hard error** that breaks model loading entirely (empty model list in the UI). Plugin configuration cannot live in `opencode.json`. We use a separate `.opencode/advisor.json` sidecar file instead.

There is no official plugin config API yet (opencode issue #4393 as of writing).

### Session ID in tool context

The tool `execute` function receives a `ToolContext` as its second argument. `context.sessionID` gives the current session ID directly — no need to track it via hooks.

Early versions tried using `hooks["chat.message"]` / `hooks["message.updated"]` to capture the session ID before the tool was called. These hooks either don't exist in the `Hooks` interface or don't fire reliably. `context.sessionID` is the right approach.

### `client.session.messages()` response shape

Returns `{ data: Array<{info: Message, parts: Part[]}>, error }` — **not** a bare array. The SDK wraps all responses in `{ data, error }`.

`messages` being null-checked via `messages!` is necessary since TypeScript considers the data field nullable when there's a potential error.

### `client.session.prompt()` — synchronous, specific body format

`session.prompt()` is **synchronous** — it waits for the model to finish and returns the full response in one call. No polling needed.

The body must use the `parts` array format:
```ts
body: {
  model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
  parts: [{ type: "text", text: "..." }]
}
```

**Not** `{ prompt: string }` — that silently posts a message that never gets processed.

Response is `{ data: { info: AssistantMessage, parts: Part[] }, error }`. Text is in `.data.parts` filtered for `type === "text"`.

### Transcript format

opencode renders sessions as a transcript in its TUI (`packages/opencode/src/cli/cmd/tui/util/transcript.ts`). We mirror that format exactly so the advisor model sees the same structured view a human would see:

- `## User` / `## Assistant` headers
- `**Tool: name**` with `**Input:** ```json ... ``` ` and `**Output:** ``` ... ``` ` blocks
- Sections separated by `---`

opencode itself does **no truncation** of tool outputs in the transcript. We add an optional `maxToolOutput` config for sessions with very large file reads or long command outputs.

`ask_advisor` calls are filtered out of the transcript to avoid infinite recursion / noise.

### Advisor runs in a separate ephemeral session

`client.session.create({})` creates a new session. The advisor prompt is sent to this session, not the working session. This means:
- The advisor can't take actions
- The advisor session remains in opencode's session history (minor cosmetic noise)
- The working session's history is passed as text context, not as actual session history

### Module resolution in `.opencode/plugins/`

Bun resolves module imports relative to the **importing file's location**, walking up the directory tree. Files in `.opencode/plugins/` look for `node_modules/` starting in `.opencode/` — but the walk continues up to the project root.

This means `.opencode/plugins/advisor.ts` can re-export from `../../src/index.ts` as long as `npm install` has been run at the project root (putting `@opencode-ai/plugin` in root `node_modules/`). When Bun loads `src/index.ts` and resolves its `@opencode-ai/plugin` import, it finds the package in the root `node_modules/`.

`src/index.ts` is therefore the single source of truth. `.opencode/plugins/advisor.ts` is a one-liner re-export used only for in-repo development.

End users doing the "copy a file" install should copy `src/index.ts` (not `.opencode/plugins/advisor.ts`) into their own project's `.opencode/plugins/`.

### Logging

`client.app.log()` writes structured logs to opencode's log directory:
- Windows: `%APPDATA%\opencode\log\`
- macOS/Linux: `~/.local/share/opencode/log/`

Run opencode with `--print-logs` to stream them to stdout. Filter with `grep "opencode-advisor"`.

---

## Design decisions

**Why not stream the advisor response?** `session.prompt()` is synchronous and returns the full response. Streaming would require polling `session.messages()` on a timer, which is fragile. The synchronous call is simpler and reliable.

**Why not give the advisor tools?** The advisor is meant to give advice, not take action. Keeping it tool-free means it can't accidentally modify files or run commands. The working model applies the advice.

**Why `maxToolOutput` instead of a fixed limit?** opencode itself has no truncation. Different projects have different characteristics — a project that reads large files frequently would hit token limits without truncation, while another might be fine without it. Making it optional lets users tune to their workload.

**Why a separate `.opencode/advisor.json` config file?** opencode.json rejects unknown keys with a hard schema error. There's no plugin config API. The sidecar file is a pragmatic workaround; `resolveConfig()` reads it silently if present, ignores it if absent.
