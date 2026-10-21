![opencode-native-pi](https://raw.githubusercontent.com/ebysofyan/opencode-native-pi/main/assets/gallery.png)

# opencode-native-pi

Use OpenCode's login-free models inside [Pi](https://pi.dev) with native SSE
streaming and Pi-owned tool execution. Slash command: `/opencode-native-pi`.
Provider ID: `opencode-cli`.

## Requirements

- Pi Coding Agent 1.3.x
- OpenCode **2.1+** on PATH (`opencode --version`); 1.x and 2.0 are unsupported
- No OpenCode login needed for the bundled free models

## Install

```bash
pi install npm:opencode-native-pi
pi install -l npm:opencode-native-pi                       # project-local
pi install git:github.com/ebysofyan/opencode-native-pi     # git source
```

Then `/reload` or restart Pi and pick an `opencode-cli` model with `/model`.

## Commands

```text
/opencode-native-pi          Read-only TUI panel; status outside TUI
/opencode-native-pi status   Cached status and registered models
/opencode-native-pi models   List model IDs
/opencode-native-pi update   Refresh catalog and capabilities
/opencode-native-pi test     Smoke-test instructions
/opencode-native-pi help     Configuration help
```

## Configuration

| Variable | Purpose |
|---|---|
| `OPENCODE_NATIVE_PI_BIN` | Executable path; default `opencode` |
| `OPENCODE_NATIVE_PI_MODELS` | Comma/space-separated model IDs; missing prefix defaults to `opencode/` |

Explicit model IDs skip startup discovery and start with conservative
text-only metadata; `/opencode-native-pi update` enriches them with catalog
capabilities and costs. Without an override, discovery registers active models
with zero input/output cost, falling back to bundled IDs if lookup fails.

## How it works

Each turn starts a private authenticated `opencode serve` on loopback with
isolated config/data directories (no global plugins or credentials), replays the
Pi transcript, system prompt and tool schemas, streams text/reasoning/tool-input
events into Pi, then tears the session and server down. OpenCode is blocked from
executing tools; only declared Pi tools with confirmed blocked handoffs come back
to Pi. Failures are visible: unknown or executed tools, incomplete handoffs,
reasoning-only replies and broken streams fail the turn.

No XML tool markers, JSON repair, server pool or cross-turn session cache. Turn
timeout defaults to 180 s (Pi's `timeoutMs`).

## Privacy

The bridge runs the real OpenCode engine and never extracts login tokens or calls
model providers directly, but prompts, tool results and images do reach the
selected model service. Free-model providers may retain inputs; don't send
confidential or patient data without checking their current policies.

## Development

```bash
npm test              # build + node:test
npm pack --dry-run
```

## License

MIT. Derived from the upstream 1.5.0 Pi extension by luongnv89 and
pi-extensions contributors; original copyright retained in
[LICENSE](LICENSE).
