# Structure — Matrix Transport Additions

## Files changed (our additions only)

| File | LOC | Role |
|------|-----|------|
| `src/transports/matrix.ts` | 267 | Matrix transport provider |
| `src/index.ts` (+48 lines) | 645 total | Extension entry: env vars, auto-connect, configure command, help |
| `src/types.ts` (+4 lines) | 73 total | Config type: `matrix` field |

## Dependency graph (our code)

```
index.ts
  └─ imports MatrixProvider from transports/matrix.ts
  └─ uses MsgBridgeConfig.matrix from types.ts

matrix.ts
  └─ imports ITransportProvider from transports/interface.ts
  └─ imports ExternalMessage from types.ts
  └─ imports ChallengeAuth from auth/challenge-auth.ts
  └─ imports matrix-bot-sdk (MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin)
  └─ module-level function: escapeHtml()
```

## Pattern comparison: Matrix vs other transports

All transports follow the same shape:
1. Constructor takes credentials + `ChallengeAuth`
2. `connect()` sets up client + message handler
3. `handleMessage()` does: filter own → filter type → auth check → admin commands → forward
4. `sendMessage()` with platform-specific formatting
5. `sendTyping()` with swallowed errors

Matrix additions to this pattern:
- `formatForMatrix()` — markdown→HTML converter (unique to Matrix)
- `getJoinedRooms()` guard in `handleMessage()` (unique to Matrix — needed because of stale sync)
- `escapeHtml()` — module-level helper (only used by `formatForMatrix`)
