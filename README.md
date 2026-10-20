# opencode-native-pi

Use OpenCode's login-free models inside [Pi](https://pi.dev), with native SSE
streaming and Pi-owned tool execution. Forked from
[opencode-pi](https://github.com/luongnv89/pi-extensions/tree/main/extensions/opencode-pi).
Provider ID stays `opencode-cli`; slash command stays `/opencode-pi`.

## Requirements

- Pi Coding Agent 1.3.x
- OpenCode **2.1+** on PATH (`opencode --version`)
- Node.js compatible with your Pi installation

OpenCode 1.x and 2.0 are not supported. No OpenCode login is required for the
bundled free models. Free-model availability and access restrictions can change.

## Install

Published on npm as [`opencode-native-pi`](https://www.npmjs.com/package/opencode-native-pi). Install with Pi's package
manager:

```bash
pi install npm:opencode-native-pi
pi install npm:opencode-native-pi@1.0.1   # pin version
pi install -l npm:opencode-native-pi      # project-local (.pi/settings.json)
```

No npm account is needed to install. Alternatively install the git source or a
local checkout:

```bash
pi install git:github.com/ebysofyan/opencode-native-pi@v1.0.1
pi install ./opencode-native-pi    # after git clone
```

Remove any previous `opencode-pi` installation before loading this fork; both
register the same provider and command. Run `/reload` or restart Pi, then choose
an `opencode-cli` model through `/model`.

## Commands

```text
/opencode-pi          Read-only TUI panel; status outside TUI
/opencode-pi status   Cached status and registered models
/opencode-pi models   List model IDs
/opencode-pi update   Refresh catalog and capabilities
/opencode-pi test     Show smoke-test instructions
/opencode-pi help     Configuration help
```

The panel hides configured values and performs no discovery or writes. Explicit
`status` and `models` commands display model IDs.

## Configuration

| Variable | Purpose |
|---|---|
| `OPENCODE_PI_BIN` | Executable path; default `opencode` |
| `OPENCODE_PI_MODELS` | Comma/space-separated model IDs; missing provider defaults to `opencode/` |

Explicit model IDs skip startup discovery and initially use conservative
text-only, non-reasoning metadata. Run `/opencode-pi update` to enrich them with
catalog capabilities and costs. Without an override, discovery selects active
models with zero input/output cost; a failed catalog lookup uses bundled model
IDs with conservative metadata instead.

Successful CLI version checks are shared across startup and turns. Failed checks
are retried. After replacing OpenCode in place, reload Pi to refresh the cached
version.

## Transport and safety

Each turn:

1. Converts the current Pi transcript, system prompt and tool schemas into a
   structured OpenCode request, including supported images and tool results.
2. Starts a private authenticated `opencode serve` on loopback with isolated
   config/data directories. Global OpenCode plugins and credentials are not loaded.
3. Streams text, reasoning and tool-input events directly into Pi events.
4. Blocks OpenCode tool execution. Only declared Pi tools with confirmed blocked
   handoffs are returned to Pi for execution.
5. Interrupts/deletes the OpenCode session, stops the server, and removes temporary
   files before emitting Pi's terminal event. Cancellation and timeouts clean up too.

Context retries before a tool handoff are allowed. Once a handoff starts, a guard
prevents OpenCode from continuing independently. That guard is treated as a
successful handoff only when every requested tool has been confirmed blocked.
Unknown tools, incomplete handoffs, executed tools, reasoning-only replies and
broken event streams fail visibly.

No legacy CLI transport, XML tool markers, JSON repair, persistent server pool or
cross-turn OpenCode session cache is used. Pi's transcript is replayed each turn;
provider-side prompt caching may still apply. Default turn timeout is 180 seconds,
overridden by Pi's `timeoutMs`.

## Latency

Version probing is shared and temporary request files are written concurrently.
Per-turn server isolation and cleanup remain deliberate safety boundaries.

A three-turn synthetic text smoke test on OpenCode 2.1 measured local readiness
at **331 / 198 / 207 ms** after these changes, versus **378 / 205 / 209 ms** before.
These few samples do not establish a reliable speedup. Post-change total times
were **3.40 / 29.85 / 2.30 seconds**: model/network latency dominates and varies.
The pre-change run also exposed two continuation-guard failures; all three
post-change turns returned `OK`.

## Development

Install TypeScript and the matching Pi peer packages in your development checkout,
then run:

```bash
npm test
npm pack --dry-run
```

Tests cover model discovery, minimum versions, shared probes, read-only UI,
structured context/images, SSE boundaries, handoff validation, context retries,
cancellation and cleanup. Test sources stay in git, not the npm tarball.

## Privacy and terms

The bridge runs the real OpenCode engine; it does not extract login tokens or call
model-provider APIs directly. Prompts, tool results and images still reach the
selected model service through OpenCode. Free-model providers may retain inputs;
do not send confidential or patient data without reviewing their current policies.
Using a CLI bridge does not waive OpenCode's or the model provider's terms.

## Attribution

Derived from `opencode-pi` 1.5.0 by luongnv89 and pi-extensions contributors,
MIT licensed. Original copyright is retained in [LICENSE](LICENSE).
