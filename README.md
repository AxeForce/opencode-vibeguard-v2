# opencode-vibeguard-v2

VibeGuard for OpenCode **V2**. Ported from the V1 plugin
[`opencode-vibeguard@0.1.0`](https://github.com/inkdust2021/opencode-vibeguard) (MIT, by inkdust2021).

Replaces configured sensitive strings with `__VG_<CATEGORY>_<hash12>__` placeholders **before requests
reach the LLM provider**, and restores them **before local tools execute** so tools always run with
real values.

## Install

```sh
# from GitHub
opencode plugin add github:AxeForce/opencode-vibeguard-v2

# from a local checkout
opencode plugin add /absolute/path/to/opencode-vibeguard-v2

# or via config
# "plugins": ["github:AxeForce/opencode-vibeguard-v2"]
```

OpenCode V2 also auto-discovers global plugins from `~/.config/opencode/plugins/`; dropping this
directory there works too.

## How it maps to the V2 plugin API

| V1 hook | V2 equivalent |
| --- | --- |
| `experimental.chat.messages.transform` | `ctx.session.hook("context" \| "compaction" \| "generate" \| "title")` |
| `tool.execute.before` | `ctx.tool.hook("execute.before")` |
| `experimental.text.complete` | ❌ not available in OpenCode 2.0.1 (see below) |

The port redacts `text` / `reasoning` / `compaction` parts, `tool-call` inputs, `tool-result`
outputs, and system parts (`event.system[].text`, which V1 could not see).

## Known limitation: placeholders in the transcript

V2 has no working response-side restore hook on OpenCode 2.0.1. If the model echoes a placeholder in
assistant text, the local transcript shows the placeholder. Tested and rejected:

| Approach | Result |
| --- | --- |
| `ctx.aisdk.hook("language", ...)` wrapping `LanguageModelV3` | Hooks register (`ctx.aisdk` exists) but are never triggered by the runtime |
| `ctx.session.hook("http.response", ...)` replacing the response body | Hook fires, but the replaced `event.response` is discarded: the trigger wraps object fields in immer drafts and resets the field with `finishDraft(draft)` after hooks |
| `session.text.ended` event | Read-only, cannot write back |

What still works: the provider never sees plaintext, and tools always receive restored values
(including `write` / `edit` / `bash`). Only the rendered/stored assistant text keeps placeholders.

Practical asymmetry:

- Tool **results** and files contain real values (they are stored as produced, e.g. a `read` or
  `browser.tabs.list` result shows real IDs).
- Model-authored **text** and **tool-call arguments** keep placeholders in the transcript, because
  OpenCode persists the model output before the `execute.before` restore runs and offers no API to
  rewrite stored messages. The execution itself still uses the restored values.

Wanted? File an upstream feature request for a text-mutation hook (the V1
`experimental.text.complete` equivalent).

## Config

Config lookup order (first match wins):

1. `OPENCODE_VIBEGUARD_CONFIG` env var
2. `<location>/vibeguard.config.json`
3. `<location>/.opencode/vibeguard.config.json`
4. `~/.config/opencode/vibeguard.config.json`

Plugin instances are location-scoped, so project configs are found before the global one. The plugin
is a no-op when no config is found or `enabled=false`. See `vibeguard.config.json.example`.

Invalid regex rules are skipped at setup with an error log instead of breaking every model request.

Builtin patterns: `email`, `china_phone`, `china_id`, `uuid`, `ipv4`, `mac`. Add your own secrets as
`keywords` and `regex` entries.

Debug: set `"debug": true` in the config or `OPENCODE_VIBEGUARD_DEBUG=1`. Debug writes load
diagnostics to `<tmpdir>/opencode-vibeguard-trace.log`.

## Development

```sh
npm test
```

Requires Node 20+. Zero runtime dependencies; the plugin only uses Node builtins.

## License

MIT. Original plugin and VibeGuard placeholder format by inkdust2021.
