# Changelog

All notable changes to this project are documented here. It follows
[Semantic Versioning](https://semver.org) and
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

### Notes

- The older CLI/marker transport is kept only for OpenCode v1.
- Global OpenCode plugins, prompts and credentials are not loaded; this mode
  targets the login-free OpenCode models.
