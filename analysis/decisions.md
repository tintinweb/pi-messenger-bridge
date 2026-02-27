# Decisions

## Scope

Only our additions: `src/transports/matrix.ts`, Matrix-related changes in `src/index.ts` and `src/types.ts`.
Upstream transport code (telegram, discord, slack, whatsapp) is out of scope.

## Action items

| # | Finding | Action | Rationale |
|---|---------|--------|-----------|
| 1 | DRY: formatForMatrix/formatForTelegram | **Accept** | Upstream code, divergent edge cases |
| 2 | DRY: sendMessage wrapper | **Accept** | Interface design, not ours |
| 3 | YAGNI: formattedBody branch | **Fix** | Simple, no behavior change |
| 4 | Bug: getJoinedRooms() per message | **Fix** | Performance — API call per event is excessive |
| 5 | Bug: getUserId() per message | **Fix** | Easy cache, called on every event |
| 6 | Bug: no stale event filtering | **Fix** | Prevents processing old messages on restart |
| 7 | hasMarkdown regex too broad | **Accept** | Harmless false positives |
