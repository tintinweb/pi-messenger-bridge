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

```bash
/msg-bridge configure slack <bot-token> <app-token>
```

Or set via environment variables:
```bash
export PI_SLACK_BOT_TOKEN="xoxb-..."
export PI_SLACK_APP_TOKEN="xapp-..."
```

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

**Cross-signing setup (recommended).** Without further setup, every encrypted room shows a red "device not verified by its owner" shield on the bot's messages; each user has to manually emoji-verify the bot's device. To make a single one-click verification suffice instead, give the bridge an SSSS recovery key it can use to import an existing cross-signing identity:

1. Log into Element (or Element X) as the bot account in an incognito window.
2. **Settings → Security & Privacy → Set up Secure Backup → Generate a Security Key.** Copy the `EsT…` key.
3. Write the key to `~/.pi/recovery-key.txt` (0600), or export it as `PI_MATRIX_RECOVERY_KEY`.
4. Sign out of Element and (re)start pi. On connect the bridge fetches the encrypted master/self-signing/user-signing keys from the homeserver's account data, decrypts them with the recovery key, imports them locally, and signs its own device.

Other users only need to verify the bot once from their own session afterwards. The bridge **refuses to silently create a fresh cross-signing identity** if no recovery key is provided — that would orphan any existing Element-side Secure Backup. Pass `PI_MATRIX_SELF_CROSS_SIGN=reset` instead to opt into bot-owned identity creation (useful for greenfield bots with no Element session of their own; requires `PI_MATRIX_ACCOUNT_PASSWORD` for UIA on the cross-signing-key upload).

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
  "slack": { "botToken": "...", "appToken": "..." },
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

## Environment Variables

Environment variables override file config:

- `PI_TELEGRAM_TOKEN` — Telegram bot token
- `PI_WHATSAPP_AUTH_PATH` — WhatsApp session directory (default: `~/.pi/msg-bridge-whatsapp-auth`)
- `PI_SLACK_BOT_TOKEN` — Slack bot token (xoxb-...)
- `PI_SLACK_APP_TOKEN` — Slack app token (xapp-...)
- `PI_DISCORD_TOKEN` — Discord bot token
- `PI_MATRIX_HOMESERVER` — Matrix homeserver URL (e.g. `https://matrix.org`)
- `PI_MATRIX_ACCESS_TOKEN` — Matrix access token
- `PI_MATRIX_SELF_CROSS_SIGN` — `1` (default when encryption is on) imports the existing cross-signing identity from SSSS if `PI_MATRIX_RECOVERY_KEY` is set, then signs the bot's own device. If neither a recovery key nor `reset` is supplied, the bridge logs an error and leaves the device unsigned rather than silently generating a new identity (which would orphan any Element-side Secure Backup). `0`/`false` skips cross-signing entirely (manual Element-side per-device trust). `reset` opts into creating a fresh bot-owned identity (destroys any prior one; requires `PI_MATRIX_ACCOUNT_PASSWORD` for UIA on `/keys/device_signing/upload`).
- `PI_MATRIX_ACCOUNT_PASSWORD` — Account password used for UIA if the homeserver requires it for `/keys/upload` cross-signing key upload. Prefer the file-based form below for non-interactive setups.
- `PI_MATRIX_PASSWORD_FILE` — Path to a 0600 file containing the account password (default `~/.pi/pi-password.txt`). Used only if `PI_MATRIX_ACCOUNT_PASSWORD` isn't set.
- `PI_MATRIX_RECOVERY_KEY` — SSSS recovery key (base58, as Element generates during "Set up Secure Backup"). When set, the bridge imports the *existing* cross-signing identity from SSSS instead of resetting it — preserves other Element-as-@bot sessions' verification. Takes precedence over the reset path.
- `PI_MATRIX_RECOVERY_KEY_FILE` — Path to a 0600 file containing the recovery key (default `~/.pi/recovery-key.txt`). Used only if `PI_MATRIX_RECOVERY_KEY` isn't set.
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
