# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Self-cross-signing bootstrap for matrix-bot-sdk bots — clears Element's "device not verified by its owner" red shield without per-device manual trust. Two paths chosen by which credential is supplied: SSSS recovery-key import (preferred — joins an Element-controlled cross-signing identity) via `PI_MATRIX_RECOVERY_KEY` / `~/.pi/recovery-key.txt`; or fresh-identity creation via `PI_MATRIX_SELF_CROSS_SIGN=reset` (UIA-via-password from `PI_MATRIX_ACCOUNT_PASSWORD` / `~/.pi/pi-password.txt`). Triggered automatically on Matrix connect when encryption is enabled; opt out with `selfCrossSign: false`. Force-pins `@matrix-org/matrix-sdk-crypto-nodejs` to `0.6.0` via npm `overrides`; matrix-bot-sdk's own `^0.4.0` pin silently drops the upload requests `bootstrapCrossSigning` generates.

### Changed
- Cross-signing helper refuses to silently create a fresh cross-signing identity when no recovery key is on disk. Operators must either provide a recovery key (preferred) or set `selfCrossSign: "reset"` (`PI_MATRIX_SELF_CROSS_SIGN=reset`) to opt into fresh-identity creation. Previously the helper would fall through to `bootstrapCrossSigning(false)` with no opt-in, generating a new server-side identity and orphaning any Element-generated Secure Backup.

### Fixed
- msg-bridge lock falsely held across container restarts because the liveness check (`process.kill(pid, 0)`) gives a false positive when the new container's PID namespace happens to reassign the same PID number to an unrelated process. Lock format extended to `<pid>:<startTime>:<instanceId>` where `startTime` is `/proc/<pid>/stat` field 22 (jiffies since boot); `acquireLock()` now requires both PID liveness AND `startTime` match to consider the lock held. Legacy 2-field locks are parseable but treated as unconditionally stale on first read after upgrade — they're exactly the format that had the bug, so one acquire-release cycle rewrites them in the new format.

## [0.4.0] - 2026-05-09

### Added
- Matrix transport via `matrix-bot-sdk` — works with Element X, Element Web, FluffyChat, any Matrix client. Auto-joins rooms, group chat support with mention detection, optional E2EE (Rust SDK crypto store). Set `"encryption": false` in the `matrix` config to disable E2EE (thanks @jchidley)
- `hideToolCalls` config option, `/msg-bridge toggletools` pi command, and matching `/toggletools` DM admin command — trusted users can hide/show tool call summaries in their replies from either side
- Empty-message guard in all transports (Discord, Telegram, Slack, WhatsApp, Matrix) to prevent provider errors on whitespace-only payloads

### Changed
- Tool call summaries now wrap the tool name in inline-code backticks (`🔧 \`hud_canvas\` (...)`), rendering as code across all 5 transports and avoiding Telegram's underscore-escape backslashes leaking into messages
- Migrated peer dependencies from deprecated `@mariozechner/pi-{ai,coding-agent,tui}` to `@earendil-works/pi-{ai,coding-agent,tui}` (>=0.74). The `@mariozechner` packages were deprecated upstream with the message "please use @earendil-works/pi-coding-agent instead going forward"
- Tightened peer constraints from `*` to `>=0.74` and removed the duplicated entries from devDependencies (npm auto-installs peers in dev)
- Bumped devDependency floors: `@biomejs/biome` ^2.4.14, `@types/node` ^25.6.2, `typescript` ^6.0.3, `vitest` ^4.1.5

### Fixed
- `sendUserMessage` crash when a remote message arrives mid-turn — messages are now queued via `{ deliverAs: "followUp" }` so each remote message gets its own turn after the current one finishes, instead of being interleaved into it (fixes #10)
- `pendingRemoteChat` no longer cleared on tool-call-only turns, so the next response reaches the right chat
- Whitespace-only assistant responses no longer trigger Discord's "Cannot send an empty message" error
- Telegram MarkdownV1 parse errors on stray special chars (e.g. snake_case tool names like `hud_canvas` triggering `400 Bad Request: can't parse entities`). `formatForTelegram` now lifts valid markdown patterns into sentinel placeholders, escapes literal `_*[\``, then restores

## [0.3.0] - 2026-03-25

### Added
- Interactive menu (`/msg-bridge` with no args) — configure, connect, widget, help via `ui.select()`
- Single-instance connection guard to prevent duplicate polling / 409 conflicts (fixes #2)
  - Layer 1: global flag for same-process re-entrant calls (sub-agents)
  - Layer 2: PID lock file (`~/.pi/msg-bridge.lock`) for cross-process duplicates
- Session shutdown handler — releases lock and disconnects transports on exit
- Lock check on `/msg-bridge configure` connect calls to prevent bypassing the guard
- Test suite (vitest): config, lock, and formatting modules
- CI workflow (GitHub Actions: lint + typecheck + test)
- Biome linter configuration

### Fixed
- Discord DM messages not received — added required `Partials.Channel` and `Partials.Message` to client options (fixes #5, thanks @chr15m)
- Transport errors now show clean messages instead of full stack traces

### Changed
- Extracted `config.ts`, `lock.ts`, `formatting.ts`, `ui/main-menu.ts` from index.ts
- Moved `@mariozechner/pi-*` packages to peerDependencies
- Updated devDependencies: typescript ^6.0.2, @types/node ^25.3.0, @biomejs/biome ^2.4.8, vitest ^4.1.1
- `prepublishOnly` now runs lint and typecheck before build
- Applied `npm audit fix` for transitive dependency vulnerabilities

## [0.2.1] - 2026-02-11

### Changed
- Package renamed from `pi-msg-bridge` to `pi-messenger-bridge` for better clarity
- Updated all repository URLs and documentation to reflect new package name
- Command remains `/msg-bridge` for brevity and ease of use

## [0.2.0] - 2026-02-11

### Added
- WhatsApp integration via Baileys library with QR code authentication
- Slack integration with Socket Mode support
- Discord integration with Message Content intent support
- Debug mode for troubleshooting (config.debug or MSG_BRIDGE_DEBUG env var)
- Non-blocking async transport initialization for faster startup
- Widget toggle command (`/msg-bridge widget`)
- Help command with full command reference
- Automatic invalid session cleanup (WhatsApp 401 handling)
- Session detection to prevent QR spam on startup

### Changed
- Renamed from "remote-pilot" to "msg-bridge" throughout codebase
- Command changed from `/remote` to `/msg-bridge`
- Config file moved from `~/.pi/msg-bridge/config.json` to `~/.pi/msg-bridge.json`
- WhatsApp auth directory: `~/.pi/msg-bridge-whatsapp-auth/`
- All debug output now behind debug flag (no spam by default)
- Status widget only shows connected transports
- Environment variables now override config file settings

### Security
- Config file permissions enforced: chmod 600 for files, 700 for directories
- Config directory permissions validated on startup with warnings
- WhatsApp auth directory created with secure permissions (700)
- Invalid WhatsApp sessions automatically cleared on 401 errors

### Fixed
- QR code display for WhatsApp (using qrcode-terminal instead of Baileys built-in)
- Tool call formatting now shows actual parameters instead of speculation
- Username extraction from WhatsApp messages
- Connection state tracking for accurate widget display
- Startup performance (transports load in background)

### Dependencies
- Added: @whiskeysockets/baileys, qrcode-terminal, @slack/bolt, discord.js
- Known vulnerabilities in transitive dependencies (node-telegram-bot-api, discord.js) - low impact for this use case

## [0.1.0] - 2026-02-10

### Added
- Initial MVP release
- Event-driven architecture using `pi.sendUserMessage()` and `turn_end` events
- Telegram bot integration with polling support
- Challenge-based authentication (6-digit codes)
- Trusted user management
- Admin commands for user and channel management
- Status widget showing connection status
- Commands: `/remote`, `/remote connect`, `/remote disconnect`, `/remote configure`
- Environment variable and file-based configuration
- Support for group chats with mention detection
- Channel authorization modes: all, mentions, trusted-only

### Security
- 6-digit challenge codes with 2-minute expiry
- 3-attempt limit with 5-minute blocking
- First authenticated user becomes admin
- Trusted user validation on all messages

[unreleased]: https://github.com/tintinweb/pi-messenger-bridge/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/tintinweb/pi-messenger-bridge/releases/tag/v0.4.0
[0.1.0]: https://github.com/tintinweb/pi-messenger-bridge/releases/tag/v0.1.0
