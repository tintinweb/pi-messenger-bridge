# Decisions

## Scope

Only our additions on branch `add-matrix-transport` (5 commits, `0e27f1d..f58389b`).
Base: `56e582f` ("more transports").
Upstream code (telegram, discord, slack, whatsapp, auth, manager) is out of scope.

## TypeScript strict mode

`tsconfig.json` has `"strict": true`. Phase 8 (types) auto-skipped per skill rules.

## Action items

| # | Finding | Action | Rationale |
|---|---------|--------|-----------|
| 1 | DRY: formatForMatrix scaffolding | **Accept** | Upstream code, divergent edge cases, out of scope |
| 2 | DRY: sendMessage wrapper | **Accept** | Interface design, not ours |
| 4 | Bug: getJoinedRoomMembers() per message | **Fix** | Network call per event; same class as already-fixed getUserId()/getJoinedRooms() |
| 5 | Bug: connect() leaks client on failure | **Fix** | Dangling client + handlers on transient network failure |
| 6 | Auth ordering | **Accept** | Correct, matches all transports |

## Scope lock

This pass will:
1. Cache room member counts to eliminate per-message API call (#4)
2. Add cleanup in connect() catch block to prevent client leak (#5)
