//! AC 27.1-6 spike tests: two desktop clients editing one project through a
//! minimal local service converge under D8.

use collaboration_merge_spike::*;

fn seed() -> Project {
    let mut p = Project::default();
    for (id, title) in [("a", "Alpha"), ("b", "Bravo"), ("c", "Charlie")] {
        p.nodes.insert(
            id.to_string(),
            Node {
                title: title.to_string(),
                parent: "root".to_string(),
                position: vec![format!("{:08}", id.as_bytes()[0] - b'a')],
            },
        );
    }
    p
}

/// Case 1: concurrent renames of the same node (same-field). D8(a).
#[test]
fn concurrent_renames_converge() {
    let mut service = Service::new();
    let mut server_state = seed();

    let mut client_a = Replica::new();
    let mut client_b = Replica::new();
    // Both clients bootstrap from the seed.
    client_a.state = seed();
    client_b.state = seed();

    // A and B both rename node "a"; the service orders A first, then B.
    service.submit(
        &mut server_state,
        Command::Rename {
            command_id: "cmd-a".into(),
            actor: "actor-a".into(),
            target: "a".into(),
            title: "Alpha (A)".into(),
        },
    );
    service.submit(
        &mut server_state,
        Command::Rename {
            command_id: "cmd-b".into(),
            actor: "actor-b".into(),
            target: "a".into(),
            title: "Alpha (B)".into(),
        },
    );

    client_a.catch_up(&service);
    client_b.catch_up(&service);

    // Later-confirmed (B) wins on both replicas.
    assert_eq!(client_a.state.nodes["a"].title, "Alpha (B)");
    assert_eq!(client_b.state.nodes["a"].title, "Alpha (B)");
    assert_eq!(canonical(&client_a.state), canonical(&client_b.state));
    assert_eq!(canonical(&client_a.state), canonical(&server_state));
}

/// Case 2: concurrent reorders (placement). D8(c) anchor fallback.
#[test]
fn concurrent_reorders_converge_with_anchor_fallback() {
    let mut service = Service::new();
    let mut server_state = seed();

    let mut client_a = Replica::new();
    let mut client_b = Replica::new();
    client_a.state = seed();
    client_b.state = seed();

    // A moves "c" after "a". B moves "b" after "c".
    service.submit(
        &mut server_state,
        Command::Move {
            command_id: "cmd-a".into(),
            actor: "actor-a".into(),
            target: "c".into(),
            after: Some("a".into()),
            before: Some("b".into()),
            intended_index: 1,
        },
    );
    service.submit(
        &mut server_state,
        Command::Move {
            command_id: "cmd-b".into(),
            actor: "actor-b".into(),
            target: "b".into(),
            after: Some("c".into()),
            before: None,
            intended_index: 2,
        },
    );

    client_a.catch_up(&service);
    client_b.catch_up(&service);

    assert_eq!(canonical(&client_a.state), canonical(&client_b.state));
    assert_eq!(canonical(&client_a.state), canonical(&server_state));
}

/// Case 2b: the after-anchor was deleted; fallback places deterministically.
#[test]
fn reorder_with_deleted_after_anchor_uses_before_anchor() {
    let mut state = seed();
    // Delete "a" first (tombstone), then move "c" intending after "a"
    // (gone) before "b".
    apply_one(
        &mut state,
        &Command::Delete {
            command_id: "d".into(),
            actor: "x".into(),
            target: "a".into(),
        },
    );
    let outcome = apply_one(
        &mut state,
        &Command::Move {
            command_id: "m".into(),
            actor: "x".into(),
            target: "c".into(),
            after: Some("a".into()),
            before: Some("b".into()),
            intended_index: 99,
        },
    );
    assert_eq!(outcome, Outcome::Applied);
    // "c" lands before "b" (the surviving anchor), not at the clamped end.
    assert_eq!(state.nodes["c"].position, vec!["00000000".to_string()]);
}

/// Case 3: a delete racing an edit. D8(b) delete beats edit.
#[test]
fn delete_beats_edit() {
    let mut service = Service::new();
    let mut server_state = seed();

    let mut client_a = Replica::new();
    let mut client_b = Replica::new();
    client_a.state = seed();
    client_b.state = seed();

    // A deletes node "b"; B concurrently renames it. Service orders delete first.
    let delete_outcome = service.submit(
        &mut server_state,
        Command::Delete {
            command_id: "cmd-del".into(),
            actor: "actor-a".into(),
            target: "b".into(),
        },
    );
    let edit_outcome = service.submit(
        &mut server_state,
        Command::Rename {
            command_id: "cmd-edit".into(),
            actor: "actor-b".into(),
            target: "b".into(),
            title: "Bravo (edited)".into(),
        },
    );

    assert_eq!(delete_outcome, Outcome::Applied);
    assert_eq!(edit_outcome, Outcome::Rejected(Rejection::TargetDeleted));

    client_a.catch_up(&service);
    client_b.catch_up(&service);

    assert!(client_a.state.deleted.contains("b"));
    assert_eq!(canonical(&client_a.state), canonical(&client_b.state));
    assert_eq!(canonical(&client_a.state), canonical(&server_state));
}

/// R2: an identical retry returns the recorded terminal result, no re-apply;
/// a reused id with a different payload is rejected without a revision.
#[test]
fn command_id_binding_is_exactly_once() {
    let mut service = Service::new();
    let mut state = seed();

    let rename = Command::Rename {
        command_id: "cmd-1".into(),
        actor: "actor-a".into(),
        target: "a".into(),
        title: "First".into(),
    };
    let first = service.submit(&mut state, rename.clone());
    assert_eq!(first, Outcome::Applied);
    let revisions_after_first = service.next_revision;

    // Identical retry.
    let retry = service.submit(&mut state, rename);
    assert_eq!(retry, Outcome::Applied);
    assert_eq!(service.next_revision, revisions_after_first);

    // Same id, different payload.
    let conflicting = service.submit(
        &mut state,
        Command::Rename {
            command_id: "cmd-1".into(),
            actor: "actor-a".into(),
            target: "a".into(),
            title: "Second".into(),
        },
    );
    assert_eq!(conflicting, Outcome::CommandIdReuse);
    assert_eq!(service.next_revision, revisions_after_first);
    // The original value is intact.
    assert_eq!(state.nodes["a"].title, "First");
}

/// The existing project-wide base-revision precondition must be replaced for
/// shared projects: a second command at a stale base must still apply after
/// the first advanced the revision.
#[test]
fn per_command_precondition_replaces_project_wide_expected_revision() {
    let mut state = seed();
    let first = apply_one(
        &mut state,
        &Command::Rename {
            command_id: "c1".into(),
            actor: "a".into(),
            target: "a".into(),
            title: "One".into(),
        },
    );
    let second = apply_one(
        &mut state,
        &Command::Rename {
            command_id: "c2".into(),
            actor: "b".into(),
            target: "b".into(),
            title: "Two".into(),
        },
    );
    // Both apply because the precondition is TargetExists, not revision == base.
    assert_eq!(first, Outcome::Applied);
    assert_eq!(second, Outcome::Applied);
}

/// The whole-list reorder shape (today's `ReorderForecastFeatures`) has no
/// anchors, so two concurrent reorders do not compose: each overwrites the
/// other's order. This is exactly why Story 27.2 must convert the six
/// whole-list commands to single moves before sharing.
#[test]
fn whole_list_reorder_does_not_compose_concurrently() {
    let mut service = Service::new();
    let mut server_state = seed();

    let mut client_a = Replica::new();
    let mut client_b = Replica::new();
    client_a.state = seed();
    client_b.state = seed();

    // A wants c, b, a. B wants b, a, c. Both send the whole list.
    service.submit(
        &mut server_state,
        Command::SetOrder {
            command_id: "order-a".into(),
            actor: "actor-a".into(),
            order: vec!["c".into(), "b".into(), "a".into()],
        },
    );
    service.submit(
        &mut server_state,
        Command::SetOrder {
            command_id: "order-b".into(),
            actor: "actor-b".into(),
            order: vec!["b".into(), "a".into(), "c".into()],
        },
    );

    client_a.catch_up(&service);
    client_b.catch_up(&service);

    // Replicas still agree with the server (server order is authoritative)...
    assert_eq!(canonical(&client_a.state), canonical(&client_b.state));
    // ...but A's intended order is entirely lost: the last whole-list write
    // wins and A's edit is silently erased. Anchored single moves (the Move
    // case) do not have this property.
    assert_eq!(server_state.nodes["a"].position, vec!["00000001".to_string()]);
    assert_eq!(server_state.nodes["c"].position, vec!["00000002".to_string()]);
}
