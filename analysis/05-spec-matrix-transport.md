# Spec — matrix-transport cluster

## Observable behaviours (contract for verification)

### `connect()`
1. Skips if already connected (`_isConnected === true`)
2. Throws if `homeserverUrl` or `accessToken` missing
3. Creates `SimpleFsStorageProvider` at `~/.pi/msg-bridge-matrix-store.json`
4. If `encryption !== false`: creates `RustSdkCryptoStorageProvider` at `~/.pi/msg-bridge-matrix-crypto/` (SQLite). If native module unavailable, warns and continues without crypto.
5. Creates `MatrixClient` with homeserver, token, storage, and optional crypto
6. Sets up `AutojoinRoomsMixin`
7. Caches `botUserId` via `getUserId()`
8. Registers event handlers: `room.join`, `room.leave`, `room.message`
9. Calls `client.start()`
10. Seeds `joinedRooms` cache from `getJoinedRooms()`
11. Records `connectedAt = Date.now()` for stale event filtering
12. Sets `_isConnected = true`
13. Logs connection status with room count and E2EE status

### `disconnect()`
1. Skips if not connected
2. Calls `client.stop()`
3. Resets all state: `_isConnected`, `client`, `botUserId`, `joinedRooms`, `connectedAt`

### `sendMessage(chatId, text)`
1. Throws if client not connected
2. Formats text via `formatForMatrix()` — returns `{ body, formattedBody? }`
3. Sends `m.text` event. If `formattedBody` present, includes `format: "org.matrix.custom.html"` and `formatted_body`

### `formatForMatrix(text)` [pure]
1. If no markdown chars (`*`, `_`, `` ` ``, `#`, `[`): returns `{ body: text }` (no HTML)
2. Protects code blocks (``` ```) and inline code (`` ` ``) via placeholder substitution
3. Converts `**bold**` → `<strong>`, `*italic*` → `<em>`, `[text](url)` → `<a href>`
4. Converts `\n` → `<br>`
5. Restores code blocks/inline code from placeholders
6. HTML-escapes content inside code blocks via `escapeHtml()`
7. Returns `{ body: originalText, formattedBody: html }`

### `sendTyping(chatId)`
1. If no client, returns silently
2. Calls `client.setTyping(chatId, true, 10000)`, swallows errors

### `handleMessage(roomId, event)` [side-effects]
1. Ignores if no client or no botUserId
2. Ignores own messages (`event.sender === botUserId`)
3. Ignores stale events (`origin_server_ts < connectedAt`)
4. Ignores non-text messages (`msgtype !== "m.text"` or no body)
5. Ignores edits (`m.new_content` present)
6. Ignores events from rooms not in `joinedRooms` cache
7. Extracts `userId` (full MXID), `username` (localpart), `messageText`, `messageId`
8. Determines `isGroupChat` by querying room member count (>2 = group)
9. In group chats: checks if bot was mentioned (full MXID or localpart)
10. Runs `auth.checkAuthorization()` with send callback
11. In DMs: handles `/commands` and 6-digit challenge codes via `auth.handleAdminCommand()`
12. If not authorized: returns
13. Strips bot mention from message text
14. Forwards to `messageHandler` as `ExternalMessage`

### `escapeHtml(text)` [pure]
Escapes `&`, `<`, `>`, `"` to HTML entities.

### Event handlers (registered in connect)
- `room.join`: adds roomId to `joinedRooms` set
- `room.leave`: removes roomId from `joinedRooms` set
- `room.message`: calls `handleMessage()`, catches errors → `errorHandler`

### index.ts additions
- Reads `PI_MATRIX_HOMESERVER` + `PI_MATRIX_ACCESS_TOKEN` env vars (override file config)
- Auto-adds MatrixProvider if `config.matrix` has both fields
- `/msg-bridge configure matrix <url> <token>` — saves config, creates provider, connects
- Help text includes matrix configure usage
- Widget shows `mx` abbreviation for matrix transport
