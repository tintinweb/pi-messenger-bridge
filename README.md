# pi-msg-bridge

Bridge common messengers (Telegram, WhatsApp, Slack, Discord) into pi.

Remote users can interact with your pi coding agent via their messenger app.

## Features

- 🔐 Challenge-based authentication (6-digit codes)
- 📱 Multi-messenger support (Telegram implemented)
- 🎯 Event-driven architecture (no polling loops)
- 🔒 Trusted user management with transport-namespaced IDs
- 📊 Live status widget (toggleable)
- 💾 Persistent config (auth state, auto-connect, widget preference)
- 🔧 Tool call visibility for remote users
- 📝 Multi-turn conversation support

## Setup

### 1. Install

```bash
pi install npm:pi-msg-bridge
```

### 2. Configure Telegram Bot

Create a bot via [@BotFather](https://t.me/BotFather) and get your token.

Set via environment variable:

```bash
export PI_TELEGRAM_TOKEN="your-bot-token-here"
```

Or configure via command:

```bash
/msg-bridge configure telegram your-bot-token-here
```

### 3. Connect

```bash
/msg-bridge connect
```

### 4. Authenticate Users

When a user messages your bot for the first time, they'll receive a 6-digit challenge code.
The code is displayed in your pi terminal. Share it with the user (e.g., via DM).

The user enters the code in the bot chat to become a trusted user.

## Commands

- `/msg-bridge` or `/msg-bridge help` — Show available commands
- `/msg-bridge status` — Show connection and user status
- `/msg-bridge connect` — Connect to configured messengers
- `/msg-bridge disconnect` — Disconnect all transports
- `/msg-bridge configure <platform> <token>` — Set transport credentials
- `/msg-bridge widget` — Toggle status widget on/off

## Environment Variables

- `PI_TELEGRAM_TOKEN` — Telegram bot token
- `PI_WHATSAPP_TOKEN` — (future) WhatsApp credentials
- `PI_SLACK_BOT_TOKEN` — (future) Slack bot token
- `PI_DISCORD_TOKEN` — (future) Discord bot token

## Architecture

Uses pi's native `sendUserMessage()` and `turn_end` events for two-way communication.
No tool-loop hacks needed — this is the pi-native way.

## License

MIT
