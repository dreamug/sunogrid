# Song Multilane Prototype Notes

## Intent

Make Song mode support multiple sessions running in parallel, visually as timeline lanes. The existing audio engine already supports many instruments playing at once; the main change is the Song arrangement model and scheduler.

## Suggested Data Shape

Minimal additive fields on `Session` / `StudioSession`:

```ts
songLane: number;      // 0-based visual/playback lane
songStartBar: number;  // global bar offset in Song mode
```

Derived values:

```ts
songEndBar = songStartBar + sessionBars(session) * sessionRepeats(session)
songLengthBars = max(songEndBar)
```

Migration for current projects:

1. Keep current session order.
2. Set every session to `songLane = 0`.
3. Compute `songStartBar` by the current cumulative `sessionBars * repeats` logic.

## Playback Boundaries

- Current scheduler assumes one active Song block. Multilane needs an event table: at every boundary, stop sessions whose end is reached and start sessions whose start is reached.
- Same bar can have multiple starts and stops. Stops should happen before starts only when reusing the same instrument ids is impossible; otherwise schedule both at the same transport time and let `swapAndRelease` avoid gaps.
- Empty gaps are valid. Transport should keep running through silence until the next start, unless playhead reaches final song end.
- Overlapping sessions may contain duplicated instruments from copied sessions. Voice ids remain unique per session copy, so overlap is fine.
- Loop song should loop from total end back to bar 0 and restart all sessions active at bar 0.
- Seeking should find all sessions active at the target bar, load them, set transport to the target bar, and start each voice at the correct local phase.
- If a session is moved or resized during playback, recompute the event table and reschedule from the current bar.
- Solo should probably be scoped by currently audible session/instrument ids. When the active set changes, stale solo ids must be filtered or the new active set can become silent.
- XY automation is currently session-local. In overlap, multiple active sessions may all define automation for the same global XY program. This needs a policy before implementation:
  - MVP: only selected/foreground session automation drives XY.
  - Alternative: highest lane wins.
  - Alternative: latest-starting active session wins.
  - Avoid mixing automation curves until there is a clear musical model.

## Export Boundaries

- `planSong` must stop accumulating sessions linearly and instead sort by `songStartBar`.
- `totalBars` becomes max end bar, not sum of all session lengths.
- Offline render can already mix overlapping blocks by scheduling multiple players in the same time range.
- Progress counts should remain based on enabled instruments in all sessions, but duplicate session copies should each prepare their own block buffers unless a cache key safely includes the rendered instrument signature.
- Export automation needs the same conflict policy as live playback.

## UI Boundaries

- The global ruler should remain one ruler across all lanes.
- The playhead should be column-level and cross every lane, matching the current `.song-ph` behavior.
- Session block width still equals `sessionBars * repeats * zoom`.
- The selected session highlight should still drive the pad editor below.
- Lane headers need compact solo/mute controls or at least reserved space. If lane mute is not implemented in MVP, keep controls visually disabled.
- Dragging a block horizontally changes `songStartBar`; dragging vertically changes `songLane`.
- Snap target should be bars at first. Sub-bar placement can wait.
- Dragging a block across others should allow overlap; do not auto-shuffle unless a "single-lane no-overlap" option is explicitly added later.
- Very short blocks need a minimum pixel width, but hit-testing/resizing should use true bar length.
- Existing session reorder by index conflicts conceptually with free placement. Keep `index` as stable list/order for sidebar or fallback, and use `songStartBar/songLane` for Song layout.
- Automation lane inside blocks becomes visually dense when many lanes are visible. MVP can keep one compact lane per block and edit only the selected block.

## Persistence And Sync Boundaries

- Add `songLane` and `songStartBar` to normalized session snapshots and diff fields.
- Undo should capture placement changes as session patches, not reorder operations.
- API update routes must accept the new fields.
- Import/export example bundles should include the new fields with fallback defaults.
- Fork project should copy the new fields.

## MVP Cut

Recommended first implementation:

1. Add nullable/defaulted `songLane` and `songStartBar`.
2. Migrate old data to lane 0 cumulative positions.
3. Replace SongTimeline layout with lanes.
4. Implement start/stop event scheduler for active sessions.
5. Update `planSong` and export render to use positioned blocks.
6. Defer automation conflict solving with a simple policy: selected active session wins; if selected is not active, latest-starting active session wins.

