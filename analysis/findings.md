# Findings — Matrix Transport

Fresh analysis of branch `add-matrix-transport` at `f58389b`.

## DRY violations

### 1. `formatForMatrix()` duplicates protect/restore scaffolding from `formatForTelegram()`

Both do: protect code blocks → protect inline code → convert bold/italic/links → restore.
Scaffolding is identical; only the inner conversions differ (HTML tags vs Telegram markdown).

**Impact:** Medium. If a new rule is added (e.g. strikethrough), both must be updated independently.
**Recommendation:** Accept — the other transports are upstream (tintinweb's). Only `matrix.ts` is ours. Extracting a shared helper would touch upstream code and the edge cases genuinely diverge (HTML escaping, `<br>` vs none, `<pre>` vs triple-backtick).

### 2. `sendMessage` wrapper in auth callbacks

Every transport creates:
```ts
const sendMessageToUser = async (cId: string, text: string) => {
  await this.sendMessage(cId, text);
};
```
Matrix does the same. Exists because `checkAuthorization` takes a callback.

**Impact:** Low. One-liner, mechanical, matches interface contract.
**Recommendation:** Accept — interface design, not ours to change.

## YAGNI / dead code

### 3. No YAGNI issues found

All code in matrix.ts is reachable:
- `formatForMatrix()` called by `sendMessage()`
- `escapeHtml()` called by `formatForMatrix()`
- `handleMessage()` called by `room.message` event handler
- All properties used
- E2EE path exercised (confirmed on pi5data)

## Bugs / robustness

### 4. `getJoinedRoomMembers()` API call on every incoming message

```ts
const members = await this.client.getJoinedRoomMembers(roomId);
isGroupChat = members.length > 2;
```

This is a **network round-trip to the homeserver per message** just to determine DM vs group. Every other transport resolves this from local/cheap metadata:
- Telegram: `msg.chat.type !== "private"` (local)
- Discord: `!isDM` (local, from channel type)
- Slack: `channelInfo.isDM` (already fetched)
- WhatsApp: `chatId.endsWith("@g.us")` (string check)

Room member count rarely changes mid-conversation. In a busy room this adds latency to every message.

**Impact:** High. Same class of issue as the per-message `getJoinedRooms()` and `getUserId()` calls that the branch's own commits (`784c273`) already fixed — this one was missed.

**Fix:** Cache per-room member count. Invalidate on `room.join`/`room.leave` events (already tracked). Or simply cache per-room `isGroupChat` boolean.

### 5. `connect()` leaks client on `client.start()` failure

```ts
this.client = new MatrixClient(...);
// ... setup event handlers ...
this.botUserId = await this.client.getUserId();
// ... more setup ...
try {
  await this.client.start();
} catch (error) {
  console.error("[Matrix] Failed to connect:", error);
  throw error;  // client, botUserId, event handlers left dangling
}
```

If `client.start()` throws, `this.client` is set but `_isConnected` is false. Next call to `connect()` returns early (`if (this._isConnected) return`) — but `this.client` is already assigned. It won't be garbage collected and event handlers are attached.

Worse: if `getUserId()` succeeds but `start()` fails, `this.botUserId` is set with no active connection, and `joinedRooms` may have stale handlers attached.

Other transports don't have this issue because Telegram's `startPolling()` is the only async setup step.

**Impact:** Medium. Manifests on transient network failures during connect.

**Fix:** Add cleanup in the catch block: `this.client = undefined; this.botUserId = undefined; this.joinedRooms.clear();`

### 6. Auth check runs before admin command handling — but this is correct

```ts
const isAuthorized = await this.auth.checkAuthorization(...);
if (!isGroupChat && ...) {
  const handled = await this.auth.handleAdminCommand(...);
  if (handled) return;
}
if (!isAuthorized) return;
```

`checkAuthorization` issues the challenge code for unknown users and returns false. Then `handleAdminCommand` processes the 6-digit code response. This ordering is correct and matches all other transports.

**Recommendation:** Accept — not a bug.

## Naming

No issues. All symbols follow the established transport naming conventions exactly:
- Class: `MatrixProvider` (matches `TelegramProvider`, `DiscordProvider`, etc.)
- Methods: `connect`, `disconnect`, `sendMessage`, `sendTyping`, `handleMessage`
- Private format helper: `formatForMatrix` (matches `formatForTelegram`)
- Properties: same pattern as other transports

## Summary

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| 1 | DRY: formatForMatrix scaffolding | Medium | **Accept** — upstream code, divergent edge cases |
| 2 | DRY: sendMessage wrapper | Low | **Accept** — interface design |
| 3 | No YAGNI | — | — |
| 4 | Bug: getJoinedRoomMembers() per message | High | **Fix** |
| 5 | Bug: connect() leaks client on start() failure | Medium | **Fix** |
| 6 | Auth ordering | — | **Accept** — correct |
