# Progress

## Completed

- [x] Phase 1: Snapshot (already on `add-matrix-transport` branch, clean)
- [x] Phase 2: Structure analysis → `analysis/structure.md`
- [x] Phase 3: Findings → `analysis/findings.md`
- [x] Phase 4: Decisions → `analysis/decisions.md`
- [x] Phase 5: Implementation
  - [x] #3 — Simplified `sendMessage` (conditional spread instead of if/else)
  - [x] #4 — Cached `joinedRooms` as `Set`, updated on room.join/room.leave events (no API call per message)
  - [x] #5 — Cached `botUserId` at connect time (was calling `getUserId()` per event)
  - [x] #6 — Added `connectedAt` timestamp, skip events with `origin_server_ts < connectedAt`
- [x] Phase 6: Build verification — `tsc` clean

## Not changed (accepted)

- #1 — DRY: formatForMatrix/formatForTelegram (upstream code, out of scope)
- #2 — DRY: sendMessage wrapper in auth callbacks (interface design)
- #7 — hasMarkdown regex (harmless false positives)
