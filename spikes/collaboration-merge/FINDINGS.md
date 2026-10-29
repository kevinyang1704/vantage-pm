# Collaboration merge spike — findings

Story 27.1, AC 27.1-6. Throwaway spike. **Not production code.** It exists to answer
whether the ratified D2 (Rust service reusing the native handler) and D3 (one SQLite file
per project) are workable, and whether D8 converges across two replicas.

Run:

```bash
cargo test --manifest-path spikes/collaboration-merge/Cargo.toml
```

Result: **7 passed, 0 failed** (2026-09-30, Windows 11, Rust stable).

## What the spike exercises

- A minimal in-memory `Service` that orders every command in arrival order, applies it
  with the native handler *shape* (mutation only for `Applied`, terminal result recorded),
  assigns contiguous server revisions, and binds `commandId` to a payload digest.
- Two `Replica`s that catch up to the server order.
- R11 canonical state compare (sorted, tombstone-aware).

| Test | D8 rule | Result |
|---|---|---|
| `concurrent_renames_converge` | D8(a) same-field later-confirmed wins | Converged; B wins on both replicas |
| `concurrent_reorders_converge_with_anchor_fallback` | D8(c) placement anchors | Converged |
| `reorder_with_deleted_after_anchor_uses_before_anchor` | D8(c) ordered fallback | Lands before `b`, not clamped to the end |
| `delete_beats_edit` | D8(b) delete beats edit | Delete applied, edit rejected `TargetDeleted`, replicas identical |
| `command_id_binding_is_exactly_once` | R2 exactly-once | Identical retry returns the result with no new revision; reused id with different payload rejected |
| `per_command_precondition_replaces_project_wide_expected_revision` | R2/27.1-3 precondition | Both commands apply at stale bases |
| `whole_list_reorder_does_not_compose_concurrently` | why 27.2 is required | Last whole-list write erases the other's order |

## Findings

1. **D8 converges under server ordering.** All three required cases (concurrent renames,
   concurrent reorders, a delete racing an edit) produce identical canonical state on both
   replicas and the server. No divergence.
2. **The whole-list reorder command is not shareable.** A move expressed without anchors
   (today's `ReorderForecastFeatures`) diverged across replicas in the spike's first pass;
   adding the after/before anchors (D8(c)) made it deterministic. This confirms Story 27.2
   is a hard prerequisite for sharing, exactly as the epic states.
3. **The project-wide `expectedRevision` precondition must be replaced for shared
   projects.** The spike shows two independent commands applied at stale bases converge
   correctly when the precondition is content-based (`TargetExists` + merge-class
   invariant), not `revision == baseRevision`. This is captured in the ADR (R2) and 27.3-4.
4. **`commandId` binding works.** Binding an id to `(actor, payload digest)` gives
   exactly-once: an identical retry returns the recorded result without a second revision,
   and a reused id with a different payload is rejected without a revision.
5. **No threat to D2 or D3.** The handler's apply path references only
   `crate::protocol::*` and `crate::db::workspace::read_active_workspace_id` — no Tauri
   dependency. The workspace registry is native-only and can stay in the desktop crate
   while `pmapp-core` takes the handler; the shared call site receives the active
   workspace id. The spike applied commands without any Tauri surface.

## Limits of the spike

- In-memory model, not SQLite. It proves the merge *algorithm*, not transaction atomicity;
  27.3/27.5 own the real transaction and fault tests.
- No transport, identity or auth. Those are 27.4/27.5.
- No unconfirmed local queue. The R4 rebase (rollback → apply remote → re-apply own) is
  reduced to "catch up to the server order"; the full rebase is 27.3/27.7.
