# Findings — Matrix Transport

## DRY violations

### 1. `formatForMatrix()` / `formatForTelegram()` — duplicated markdown conversion pattern
Both methods do the same thing: protect code blocks → protect inline code → convert bold/italic/links → restore. The protect/restore scaffolding is identical; only the target format differs (HTML vs Telegram markdown).

**Impact:** Medium. Each transport has its own copy. If a new format rule is added, all must be updated.

**Fix:** Extract a generic `markdownTransform(text, converters)` that handles the protect/restore scaffolding, with platform-specific converters injected. Or accept the duplication since each platform's edge cases diverge enough that a shared abstraction may not simplify.

**Recommendation:** Accept for now — the transports are upstream code (tintinweb's). Only `matrix.ts` is ours. Shared abstraction would be a bigger refactor across all transports.

### 2. `sendMessage` duplication in auth callbacks
In `handleMessage()`:
```ts
const sendMessageToUser = async (cId: string, text: string) => {
  await this.sendMessage(cId, text);
};
```
Every transport creates this identical wrapper. It exists because `checkAuthorization` takes a callback rather than the transport itself.

**Impact:** Low. One-liner, mechanical.

**Recommendation:** Accept — this is the interface's design, not ours to change.

## YAGNI / dead code

### 3. `formattedBody` branch in `sendMessage` could be simplified
```ts
if (formattedBody) {
  await this.client.sendMessage(chatId, { msgtype: "m.text", body, format: "org.matrix.custom.html", formatted_body: formattedBody });
} else {
  await this.client.sendMessage(chatId, { msgtype: "m.text", body });
}
```
Could be a single call — Matrix ignores `format`/`formatted_body` if not present, but sending them as `undefined` is fine too.

**Impact:** Low. Readability preference.

**Recommendation:** Simplify to single call with conditional spread.

## Bugs / robustness issues

### 4. `getJoinedRooms()` called on every message — API call per event
The room membership guard does a full API round-trip to matrix.org on every incoming message. In a busy room this is excessive.

**Fix:** Cache joined rooms list, refresh on room join/leave events.

### 5. `getUserId()` called on every message — should be cached
`await this.client.getUserId()` is called in `handleMessage()` on every event. The bot's own user ID never changes.

**Fix:** Cache at connect time.

### 6. No stale event filtering
Telegram has `lastProcessedMessageId` to skip old events on reconnect. Matrix has no equivalent. The `getJoinedRooms()` guard helps with left rooms, but doesn't prevent processing old messages from current rooms after a restart (the initial sync replays them).

**Fix:** Store the latest processed `origin_server_ts` or use the sync token's timeline position to skip events older than the connection time.

### 7. `hasMarkdown` regex is too broad
```ts
const hasMarkdown = /[*_`#\[]/.test(text);
```
Matches any text containing `*`, `_`, `` ` ``, `#`, or `[` — even in prose like "I can't believe it" (no markdown). Results in unnecessary HTML conversion.

**Impact:** Low — Matrix handles both formats fine. Just wasteful.

**Recommendation:** Accept. False positives are harmless.

## Naming

No issues found. `MatrixProvider`, `formatForMatrix`, `handleMessage` all follow the established transport pattern.
