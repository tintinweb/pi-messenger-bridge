# Structure — Matrix Transport (branch: add-matrix-transport)

## Scope

Branch `add-matrix-transport` diverges from `56e582f` (base: "more transports"). 5 commits.
A parallel branch `add-matrix-js-sdk` (`7eb1057`) tried `matrix-js-sdk` but was abandoned; this branch uses `matrix-bot-sdk` instead. Some structural patterns may carry over from there.

### Files changed

| File | Delta | Total LOC | Role |
|------|-------|-----------|------|
| `src/transports/matrix.ts` | +318 (new) | 318 | Matrix transport provider (E2EE via Rust crypto) |
| `src/index.ts` | +47 | 644 | Extension entry: import, env vars, auto-connect, configure cmd, help |
| `src/types.ts` | +5 | 74 | Config type: `matrix` field |
| `src/ui/status-widget.ts` | +1 | 33 | `matrix: "mx"` abbreviation |

**Total branch additions: 371 LOC** → inline mode (< 1500).

## Symbol table — `src/transports/matrix.ts`

| Symbol | Kind | Vis | LOC | Purity |
|--------|------|-----|-----|--------|
| `MatrixProvider` | class | export | 318 | [side-effects: network, fs] |
| `.type` | prop | pub/ro | 1 | [pure] |
| `.client` | prop | priv | 1 | — |
| `._isConnected` | prop | priv | 1 | — |
| `.messageHandler` | prop | priv | 1 | — |
| `.errorHandler` | prop | priv | 1 | — |
| `.botUserId` | prop | priv | 1 | — |
| `.joinedRooms` | prop | priv | 1 | — |
| `.connectedAt` | prop | priv | 1 | — |
| `.isConnected` | getter | pub | 3 | [pure] |
| `.formatForMatrix()` | method | priv | 35 | [pure] |
| `.connect()` | method | pub | 55 | [side-effects: network, fs, console] |
| `.disconnect()` | method | pub | 10 | [side-effects: network, console] |
| `.sendMessage()` | method | pub | 15 | [side-effects: network] |
| `.sendTyping()` | method | pub | 7 | [side-effects: network] |
| `.onMessage()` | method | pub | 3 | [pure — sets callback] |
| `.onError()` | method | pub | 3 | [pure — sets callback] |
| `.handleMessage()` | method | priv | 80 | [side-effects: network via auth + member query] |
| `.escapeHtml()` | method | priv | 6 | [pure] |

## Symbol table — `src/index.ts` additions

| Symbol/block | Where | LOC |
|--------------|-------|-----|
| `import { MatrixProvider }` | top | 1 |
| `PI_MATRIX_*` env override | `loadConfig()` | 5 |
| Matrix auto-add | `session_start` async block | 11 |
| `case "matrix"` configure | `msg-bridge` command handler | 25 |
| Help text lines | help case | 2 |
| Matrix config type | `types.ts` | 5 |
| Widget abbreviation | `status-widget.ts` | 1 |

## Dependency graph

```
src/transports/matrix.ts
  ← src/index.ts (imports MatrixProvider, constructs with config.matrix)
  → src/transports/interface.ts (implements ITransportProvider)
  → src/types.ts (uses ExternalMessage)
  → src/auth/challenge-auth.ts (uses ChallengeAuth)
  → matrix-bot-sdk (MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin,
                     RustSdkCryptoStorageProvider, RustSdkCryptoStoreType)
  → node:path, node:os

src/types.ts   ← all transports + index.ts
src/ui/status-widget.ts ← index.ts
```

## Clusters

Single cluster: **matrix-transport**. All additions serve one concern.
318 LOC main file — within 300–500 target. No decomposition needed.
