# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[unreleased]: https://github.com/tintinweb/pi-msg-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tintinweb/pi-msg-bridge/releases/tag/v0.1.0
