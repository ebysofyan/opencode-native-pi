# Changelog

All notable changes to this project are documented here. It follows
[Semantic Versioning](https://semver.org) and
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.3] - 2026-10-21

### Changed

- Rename the slash command to `/opencode-native-pi`, notices/panels to
  `opencode-native-pi`, and provider/model display names to **OpenCode Native Pi**.
  Keep provider/API IDs and environment variables unchanged for compatibility;
  retain upstream attribution. The old `/opencode-pi` command is no longer registered.

### Fixed

- Preserve valid Pi tool names instead of prefixing every declaration, fixing
  `OpenCode requested unavailable Pi tool: bash` when instructions/history use
  Pi's real names. Undeclared tools remain blocked.
- Clone the replayed transcript on each context rebuild, preventing native
  mutations from contaminating retries. Retain the handoff-based continuation
  guard and concurrent startup-file writes.
- Add regressions for canonical names, `bash` handoff/allowlisting and immutable
  request history.

## [1.0.2] - 2026-10-21

### Added

- Gallery banner (`pi.image`) and README preview so the package card on
  `pi.dev/packages` shows what the bridge does.

## [1.0.1] - 2026-10-21

### Changed

- README now leads with the published npm package; git and local checkouts are
  documented as fallbacks.

## [1.0.0] - 2026-10-21

First release under the `opencode-native-pi` name. Forked from `opencode-pi`
1.5.0 (MIT, luongnv89/pi-extensions) and versioned from 1.0.0 as a separate
package.

### Added

- **Native OpenCode v2 transport** (`src/native.ts`): each turn starts a private,
  authenticated `opencode serve` with an isolated config/data directory and
  consumes native server-event streaming. Text, reasoning and tool-input deltas
  become Pi stream events.
- Pi tool schemas are published to the OpenCode session; validated native tool
  calls are handed back to Pi and executed there. No XML markers and no
  tool-name guessing on the v2 path.
- Structured message and tool-result replay, plus current system prompt and tool
  state, so the adapter sees the same turn context Pi does.
- Unknown, unconfirmed or incomplete tool calls, reasoning-only replies,
  disconnects and timeouts fail the turn instead of reporting success.
- Private server and session files are removed on success, error, timeout and
  abort.

### Changed

- Provider registration uses Pi 1.3's API instead of the removed global API
  registry.
- OpenCode v2 children explicitly enable project configuration inside the
  isolated bridge directory, even when a local CLI wrapper disables it. The
  wrapper and its global settings are not modified.
- Transcript serialization failures return a stream error rather than exiting Pi.

### Simplified and optimized

- Require OpenCode 2.1+; remove the legacy CLI transport, XML marker parser,
  JSON repair and persistent v1 session bookkeeping.
- Reuse one successful CLI version probe across startup, discovery and turns;
  failed probes remain retryable and executable changes invalidate the cache.
- Write independent temporary request files concurrently, settling writes before
  cleanup on failure.
- Keep context retries available before tool handoff; block continuation only
  after a tool handoff starts. Accept that guard only for confirmed handoffs.
- Keep native streaming, isolated per-turn servers, tool validation and cleanup.

### Notes

- Global OpenCode plugins, prompts and credentials are not loaded; this mode
  targets the login-free OpenCode models.
