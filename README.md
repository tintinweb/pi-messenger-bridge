# pi-messenger-bridge

Bridge common messengers (Telegram, WhatsApp, Slack, Discord, Matrix) into pi.

Remote users can interact with your pi coding agent via their messenger app.

<img width="887" height="656" alt="image" src="https://github.com/user-attachments/assets/d42a41e5-e7d5-420b-be8e-f2191facb190" />

https://github.com/user-attachments/assets/cd64360e-e8cd-4820-a67f-bd127c5d6035

## Features

- 📱 Multi-messenger support (Telegram, WhatsApp, Slack, Discord, Matrix)
- 🔐 Challenge-based authentication (6-digit codes)
- 🎛️ Interactive menu (`/msg-bridge`) for setup and management
- 🔒 Single-instance guard — prevents duplicate bot polling with sub-agents
- 📊 Live status widget (toggleable)
- 💾 Persistent config (auth state, auto-connect, widget preference)
- 🔧 Tool call visibility for remote users
- 📝 Multi-turn conversation support
- 🔑 Secure permissions (chmod 600 for config files, 700 for directories)

## Setup

### 1. Install

```bash
pi install npm:pi-messenger-bridge
```

### 2. Configure Transports

#### Telegram

Create a bot via [@BotFather](https://t.me/BotFather) and get your token.

```bash
/msg-bridge configure telegram <bot-token>
```

Or set via environment variable:
```bash
export PI_TELEGRAM_TOKEN="your-bot-token-here"
```

#### WhatsApp

Configure WhatsApp (requires QR code scan):

```bash
/msg-bridge configure whatsapp
```

Scan the QR code with your WhatsApp mobile app (**Linked Devices → Link a device**).

> **Note:** After linking, **send a message to your own phone number** in WhatsApp to activate the bridge.

Or set custom auth path:
```bash
export PI_WHATSAPP_AUTH_PATH="/path/to/whatsapp-auth"
```

#### Slack

Create a Slack app with Socket Mode enabled. You need both tokens:

- Bot User OAuth Token: `xoxb-...`
- App-Level Token: `xapp-...`

Slack app setup:

1. **Socket Mode**: enable Socket Mode.
2. **App-Level Token**: create an app-level token with scope `connections:write`.
3. **OAuth & Permissions → Bot Token Scopes**: add these scopes:
   - `chat:write` — send replies
   - `users:read` — resolve Slack user names
   - `channels:read`, `groups:read`, `im:read`, `mpim:read` — inspect conversations and detect DMs vs channels
   - `channels:history`, `groups:history`, `im:history`, `mpim:history` — receive messages from public channels, private channels, DMs, and multi-person DMs
   - `files:read` — download image files attached to Slack messages so they can be sent to the model
   - `reactions:write` — optional; only required if `slack.brainReaction` is enabled
4. **Event Subscriptions → Subscribe to bot events**: add the message events you want the bridge to receive:
   - `message.im` — direct messages
   - `message.mpim` — multi-person DMs
   - `message.channels` — public channels where the bot is a member
   - `message.groups` — private channels where the bot is a member
5. Install/reinstall the app to your workspace after changing scopes or events.
6. Invite the bot to any channel where it should respond.

Slack image handling supports PNG, JPEG, GIF, and WebP files up to 20 MB. Images are downloaded with the bot token and forwarded to pi as image inputs alongside the Slack message text.

Configure the bridge:

```bash
/msg-bridge configure slack <bot-token> <app-token>
```

Or set via environment variables:
```bash
export PI_SLACK_BOT_TOKEN="xoxb-..."
export PI_SLACK_APP_TOKEN="xapp-..."
```

Optional processing reaction: set `"brainReaction": true` under `slack` in `~/.pi/msg-bridge.json` to add a 🧠 reaction while pi is working, then remove it when pi is idle. This requires `reactions:write`.

#### Discord

1. Create a new application in the [Developer Portal](https://discord.com/developers/applications)
2. Go to **Bot** → **Reset Token** → copy the token
3. Enable **Message Content Intent** (under Privileged Gateway Intents on the same page)
4. Go to **OAuth2 → URL Generator** → select scope `bot` → select permissions `Send Messages` and `Read Message History` → open the generated URL to invite the bot to your server

```bash
/msg-bridge configure discord <bot-token>
```

Or set via environment variable:
```bash
export PI_DISCORD_TOKEN="your-bot-token"
```

#### Matrix

Works with any Matrix homeserver — Element X, Element Web, FluffyChat, etc. The bot auto-joins rooms it's invited to.

1. Register a bot account on your homeserver (or reuse an existing user)
2. Get an access token: log in once via Element and copy from **Settings → Help & About → Advanced**, or POST to `/_matrix/client/v3/login`
3. Note your homeserver URL (e.g. `https://matrix.org`)

```bash
/msg-bridge configure matrix <homeserver-url> <access-token>
```

Or set via environment variables:
```bash
export PI_MATRIX_HOMESERVER="https://matrix.org"
export PI_MATRIX_ACCESS_TOKEN="syt_..."
```

E2EE is **on by default**. Verify the bot's device once from another Matrix client (Element, etc.) — until verified, encrypted rooms can't be decrypted in either direction.

Set `"encryption": false` in the `matrix` config to disable — useful for non-encrypted rooms only, or to bypass crypto-store/server desync (e.g. `M_UNKNOWN: One time key … already exists`). **Caveat:** with E2EE off, the homeserver sees plaintext, and the bot can't participate in encrypted rooms at all.

### 3. Connect

```bash
/msg-bridge connect
```

### 4. Authenticate Users

When a user messages your bot for the first time, they'll receive a 6-digit challenge code.
The code is displayed in your pi terminal. Share it with the user (e.g., via DM).

The user enters the code in the bot chat to become a trusted user.

## Commands

| Command | Description |
|---|---|
| `/msg-bridge` | Open interactive menu (configure, connect, widget, help) |
| `/msg-bridge status` | Show connection and user status |
| `/msg-bridge connect` | Connect to all configured transports |
| `/msg-bridge disconnect` | Disconnect all transports |
| `/msg-bridge configure <platform> [token]` | Set transport credentials via CLI |
| `/msg-bridge widget` | Toggle status widget on/off |
| `/msg-bridge toggletools` | Toggle tool call visibility in remote messages |
| `/msg-bridge help` | Show command reference |

### Admin commands (in DM with the bot)

Trusted users can DM the bot directly to manage state. Reply with `/help` for the full list:

| Command | Description |
|---|---|
| `/help` | Show admin command reference |
| `/trusted` | List trusted users |
| `/revoke <userId>` | Revoke trust for a user |
| `/channels` | List enabled channels |
| `/enable <chatId> <all\|mentions\|trusted-only>` | Enable a channel |
| `/disable <chatId>` | Disable a channel |
| `/toggletools` | Toggle tool call visibility in replies |

## Configuration

Config is stored at `~/.pi/msg-bridge.json` with secure permissions (chmod 600).

Example config:
```json
{
  "telegram": { "token": "..." },
  "whatsapp": { "authPath": "..." },
  "slack": { "botToken": "...", "appToken": "...", "brainReaction": false },
  "discord": { "token": "..." },
  "matrix": { "homeserverUrl": "https://matrix.org", "accessToken": "syt_...", "encryption": true },
  "auth": {
    "trustedUsers": ["telegram:123", "whatsapp:456"],
    "adminUserId": "telegram:789"
  },
  "autoConnect": true,
  "showWidget": true,
  "debug": false
}
```

Slack-specific options:

- `slack.brainReaction` — defaults to `false`. Set to `true` to opt in to adding/removing a 🧠 reaction on Slack messages while pi is processing them. Requires Slack `reactions:write` scope.

## Environment Variables

Environment variables override file config:

- `PI_TELEGRAM_TOKEN` — Telegram bot token
- `PI_WHATSAPP_AUTH_PATH` — WhatsApp session directory (default: `~/.pi/msg-bridge-whatsapp-auth`)
- `PI_SLACK_BOT_TOKEN` — Slack bot token (xoxb-...)
- `PI_SLACK_APP_TOKEN` — Slack app token (xapp-...)
- `PI_DISCORD_TOKEN` — Discord bot token
- `PI_MATRIX_HOMESERVER` — Matrix homeserver URL (e.g. `https://matrix.org`)
- `PI_MATRIX_ACCESS_TOKEN` — Matrix access token
- `MSG_BRIDGE_DEBUG` — Enable debug logging (true/false)

## Security

- Config file: `~/.pi/msg-bridge.json` (chmod 600 - owner read/write only)
- Config directory: `~/.pi/` (chmod 700 - owner only)
- WhatsApp auth: `~/.pi/msg-bridge-whatsapp-auth/` (chmod 700 - owner only)
- Environment variables take precedence over config file
- Challenge-based authentication for all new users
- Transport-namespaced user IDs prevent impersonation

## Troubleshooting

Enable debug mode to see detailed logs:

```json
{
  "debug": true
}
```

Or:
```bash
export MSG_BRIDGE_DEBUG=true
```

## Architecture

Uses pi's native `sendUserMessage()` and `turn_end` events for two-way communication.
No tool-loop hacks needed — this is the pi-native way.

Single-instance connection guard prevents duplicate polling when sub-agents spawn
(global flag + PID lock file at `~/.pi/msg-bridge.lock`).

## Development

```bash
npm install
npm run build        # compile TypeScript
npm run typecheck    # type-check without emitting
npm run test         # run tests
npm run lint         # biome lint
npm run lint:fix     # biome lint with auto-fix
```

## License

MIT
