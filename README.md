# opencode-vibeguard-v2

VibeGuard for OpenCode **V2**. Ported from the V1 plugin
[`opencode-vibeguard@0.1.0`](https://github.com/inkdust2021/opencode-vibeguard) (MIT, by inkdust2021).

Replaces configured sensitive strings with `__VG_<CATEGORY>_<hash12>__` placeholders **before requests
reach the LLM provider**, and restores them **before local tools execute** so tools always run with
real values.

## Install

Published as a package plugin. Add it to `opencode.json(c)` or install with the CLI:

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
| `experimental.text.complete` | `ctx.aisdk.hook("language", ...)` — opt-in `restore_stream` (see below) |

The port redacts `text` / `reasoning` / `compaction` parts, `tool-call` inputs, `tool-result`
outputs, and system parts (`event.system[].text`, which V1 could not see).

## Response-stream restore (`restore_stream`)

V2 has no `experimental.text.complete` hook. The closest equivalent is wrapping the AI SDK
`LanguageModelV3` via `ctx.aisdk.hook("language", ...)` and restoring placeholders in the
provider stream before OpenCode persists and renders it.

```jsonc
{
  "restore_stream": true
}
```

- Restores `text-delta`, `reasoning-delta`, `tool-input-delta`, and `doGenerate` content.
- Placeholders split across stream chunks are buffered and restored when complete.
- Off by default. Without it, placeholders may remain visible in assistant text (the provider
  still never sees plaintext, and tools still get real values).

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

Debug logging: set `"debug": true` in the config or `OPENCODE_VIBEGUARD_DEBUG=1`.

## Development

```sh
npm test
```

Requires Node 20+. Zero runtime dependencies; the plugin only uses Node builtins.

## License

MIT. Original plugin and VibeGuard placeholder format by inkdust2021.
