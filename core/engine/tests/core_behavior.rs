use rusqlite::{Connection, params};
use serde_json::json;
use ultracontext::{
    AppendInput, ArtifactSave, ContentStore, DeleteTarget, ErrorCode, FileWrite, ForkOptions,
    GetOptions, S3ContentStore, SearchKind, UltraContext, UltraContextOptions, UpdatePatch,
};

fn temp_db(name: &str) -> String {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "ultracontext-v2-{name}-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    path.to_string_lossy().into_owned()
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "ultracontext-v2-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    path
}

struct MockS3Server {
    endpoint: String,
    handle: std::thread::JoinHandle<()>,
}

impl MockS3Server {
    fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let stored = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let thread_stored = stored.clone();
        let handle = std::thread::spawn(move || {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                handle_mock_s3_request(&mut stream, &thread_stored);
            }
        });
        Self { endpoint, handle }
    }

    fn join(self) {
        self.handle.join().unwrap();
    }
}

fn handle_mock_s3_request(
    stream: &mut std::net::TcpStream,
    stored: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
) {
    use std::io::{Read, Write};

    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end = loop {
        let read = stream.read(&mut chunk).unwrap();
        assert!(read > 0);
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };

    let header = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header.lines();
    let request_line = lines.next().unwrap().to_string();
    let lower_header = header.to_ascii_lowercase();
    assert!(lower_header.contains("authorization: aws4-hmac-sha256"));

    let content_length = lower_header
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).unwrap();
        assert!(read > 0);
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);

    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap();
    let path = request_parts.next().unwrap();
    assert!(path.starts_with("/bucket/uc-test/artifacts/art_"));

    match method {
        "PUT" => {
            *stored.lock().unwrap() = body;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        }
        "GET" => {
            let body = stored.lock().unwrap().clone();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        }
        "DELETE" => {
            stored.lock().unwrap().clear();
            write!(
                stream,
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        }
        other => panic!("unexpected mock S3 method: {other}"),
    }
}

#[test]
fn legacy_context_roots_are_migrated_into_workspaces() {
    let db = temp_db("legacy-migration");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "
        CREATE TABLE nodes (
            id         INTEGER PRIMARY KEY,
            public_id  TEXT NOT NULL,
            kind       TEXT NOT NULL CHECK (kind IN ('context', 'message', 'artifact')),
            content    TEXT NOT NULL DEFAULT '{}',
            metadata   TEXT NOT NULL DEFAULT '{}',
            data       BLOB,
            prev       INTEGER REFERENCES nodes(id),
            parent     INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
            owner      INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL
        );
        ",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO nodes (id, public_id, kind, content, metadata, created_at)
         VALUES (1, 'ctx_legacy', 'context', '{}', '{}', '2026-01-01T00:00:00.000Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO nodes (id, public_id, kind, content, metadata, owner, created_at)
         VALUES (2, 'ctx_head', 'context', '{}', '{}', 1, '2026-01-01T00:00:00.001Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO nodes (id, public_id, kind, content, metadata, owner, created_at)
         VALUES (3, 'msg_legacy', 'message', ?1, '{}', 2, '2026-01-01T00:00:00.002Z')",
        params![json!({"content": "legacy message"}).to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO nodes (id, public_id, kind, content, metadata, data, owner, created_at)
         VALUES (4, 'art_legacy', 'artifact', ?1, '{}', ?2, 1, '2026-01-01T00:00:00.003Z')",
        params![
            json!({
                "path": "legacy.md",
                "kind": "text/markdown",
                "size": 6,
                "sha256": "legacy",
                "storage": {"type": "inline"}
            })
            .to_string(),
            b"legacy".to_vec()
        ],
    )
    .unwrap();
    drop(conn);

    let uc = UltraContext::open(db).unwrap();
    let context = uc.get("ctx_legacy", GetOptions::default()).unwrap();
    assert_eq!(context.data[0].content["content"], "legacy message");

    let workspaces = uc.list_workspaces().unwrap();
    assert_eq!(workspaces.len(), 1);
    let files = uc.list_workspace_artifacts(&workspaces[0].id).unwrap();
    assert_eq!(files[0].path, "legacy.md");

    let artifact = uc.load_artifact("ctx_legacy", "legacy.md", None).unwrap();
    assert_eq!(artifact.data.as_deref(), Some("legacy"));

    let snapshot = uc.export_snapshot().unwrap();
    let nodes = snapshot["nodes"].as_array().unwrap();
    let session = nodes
        .iter()
        .find(|node| node["public_id"] == "ctx_legacy")
        .unwrap();
    assert_eq!(session["kind"], "session");
    let session_rowid = session["id"].as_i64().unwrap();
    let context_head = nodes
        .iter()
        .find(|node| node["public_id"] == "ctx_head")
        .unwrap();
    assert_eq!(context_head["kind"], "context");
    assert_eq!(context_head["owner"].as_i64(), Some(session_rowid));
}

#[test]
fn intermediate_session_context_roots_are_flattened() {
    let db = temp_db("intermediate-root-migration");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "
        CREATE TABLE nodes (
            id         INTEGER PRIMARY KEY,
            public_id  TEXT NOT NULL,
            kind       TEXT NOT NULL CHECK (kind IN ('workspace', 'session', 'context', 'message', 'artifact')),
            content    TEXT NOT NULL DEFAULT '{}',
            metadata   TEXT NOT NULL DEFAULT '{}',
            data       BLOB,
            prev       INTEGER REFERENCES nodes(id),
            parent     INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
            owner      INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL
        );
        ",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO nodes (id, public_id, kind, content, metadata, created_at)
         VALUES (1, 'ws_project', 'workspace', '{}', '{}', '2026-01-01T00:00:00.000Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO nodes (id, public_id, kind, content, metadata, owner, created_at)
         VALUES (2, 'ses_run', 'session', '{}', '{}', 1, '2026-01-01T00:00:00.001Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO nodes (id, public_id, kind, content, metadata, owner, created_at)
         VALUES (3, 'ctx_root', 'context', ?1, '{}', 2, '2026-01-01T00:00:00.002Z')",
        params![json!({"role": "root"}).to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO nodes (id, public_id, kind, content, metadata, owner, created_at)
         VALUES (4, 'ctx_head', 'context', ?1, '{}', 3, '2026-01-01T00:00:00.003Z')",
        params![json!({"projection": true}).to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO nodes (id, public_id, kind, content, metadata, owner, created_at)
         VALUES (5, 'msg_projected', 'message', ?1, '{}', 4, '2026-01-01T00:00:00.004Z')",
        params![json!({"content": "projected"}).to_string()],
    )
    .unwrap();
    drop(conn);

    let uc = UltraContext::open(db).unwrap();
    let current = uc.get("ses_run", GetOptions::default()).unwrap();
    assert_eq!(current.data[0].content["content"], "projected");

    let snapshot = uc.export_snapshot().unwrap();
    let nodes = snapshot["nodes"].as_array().unwrap();
    assert!(
        !nodes
            .iter()
            .any(|node| node["kind"] == "context" && node["content"]["role"] == "root")
    );
    let head = nodes
        .iter()
        .find(|node| node["public_id"] == "ctx_head")
        .unwrap();
    assert_eq!(head["owner"].as_i64(), Some(2));
    assert_eq!(head["prev"].as_i64(), Some(3));
}

#[test]
fn context_messages_are_appendable_and_versioned() {
    let uc = UltraContext::open(temp_db("context")).unwrap();

    let created = uc.create(json!({"project": "demo"})).unwrap();
    let appended = uc
        .append(
            &created.id,
            vec![
                AppendInput::new(json!({"role": "user", "content": "oi"})),
                AppendInput::new(json!({"role": "assistant", "content": "ola"})),
            ],
        )
        .unwrap();

    assert_eq!(appended.version, 0);
    assert_eq!(appended.data.len(), 2);

    let updated = uc
        .update_message(
            &created.id,
            UpdatePatch::by_index(1, json!({"content": "ola!"})),
            json!({"reason": "punctuation"}),
        )
        .unwrap();

    assert_eq!(updated.version, 1);
    assert_eq!(updated.data[1].content["content"], "ola!");

    let current = uc.get(&created.id, GetOptions::default()).unwrap();
    let old = uc
        .get(&created.id, GetOptions { version: Some(0) })
        .unwrap();

    assert_eq!(current.version, 1);
    assert_eq!(current.data[1].content["content"], "ola!");
    assert_eq!(old.version, 0);
    assert_eq!(old.data[1].content["content"], "ola");
}

#[test]
fn context_history_clear_and_restore_are_core_operations() {
    let uc = UltraContext::open(temp_db("context-history")).unwrap();

    let created = uc.create(json!({"project": "demo"})).unwrap();
    let appended = uc
        .append(
            &created.id,
            vec![
                AppendInput::new(json!({"role": "user", "content": "draft"})),
                AppendInput::new(json!({"role": "assistant", "content": "ready"})),
            ],
        )
        .unwrap();
    assert_eq!(appended.version, 0);

    let updated = uc
        .update_message(
            &created.id,
            UpdatePatch::by_index(1, json!({"content": "ready!"})),
            json!({"reason": "punctuation"}),
        )
        .unwrap();
    let updated_context_id = updated.context_id.clone();

    let cleared = uc
        .clear_context(&created.id, json!({"reason": "new model window"}))
        .unwrap();
    assert_eq!(cleared.version, 2);
    assert!(cleared.data.is_empty());

    let restored = uc
        .restore_context(
            &created.id,
            &updated_context_id,
            json!({"reason": "time travel"}),
        )
        .unwrap();
    assert_eq!(restored.version, 3);
    assert_eq!(restored.data.len(), 2);
    assert_eq!(restored.data[1].content["content"], "ready!");

    let current = uc.get(&created.id, GetOptions::default()).unwrap();
    assert_eq!(current.context_id, restored.context_id);
    assert_eq!(current.data[1].content["content"], "ready!");

    let history = uc.context_history(&created.id).unwrap();
    assert_eq!(history.data.len(), 4);
    assert_eq!(history.data[0].operation, "create");
    assert_eq!(history.data[1].operation, "update");
    assert_eq!(history.data[2].operation, "clear");
    assert_eq!(history.data[3].operation, "restore");
    assert_eq!(history.data[3].id, restored.context_id);
    assert!(history.data[3].current);
}

#[test]
fn workspace_owns_artifacts_across_sessions() {
    let uc = UltraContext::open(temp_db("workspace-artifacts")).unwrap();
    let workspace = uc.create_workspace(json!({"name": "project"})).unwrap();
    let first = uc
        .create_in_workspace(&workspace.id, json!({"name": "first"}))
        .unwrap();
    let second = uc
        .create_session(&workspace.id, json!({"name": "second"}))
        .unwrap();

    let saved = uc
        .save_artifact(
            &first.id,
            ArtifactSave::new("brief.md", "text/markdown", "# Brief"),
        )
        .unwrap();

    let loaded = uc
        .load_artifact(&second.context_id, "brief.md", None)
        .unwrap();
    assert_eq!(loaded.id, saved.id);
    assert_eq!(loaded.data.as_deref(), Some("# Brief"));

    let workspace_files = uc.list_workspace_artifacts(&workspace.id).unwrap();
    assert_eq!(workspace_files.len(), 1);
    assert_eq!(workspace_files[0].path, "brief.md");

    let snapshot = uc.export_snapshot().unwrap();
    let nodes = snapshot["nodes"].as_array().unwrap();
    let workspace_rowid = nodes
        .iter()
        .find(|node| node["public_id"] == workspace.id)
        .and_then(|node| node["id"].as_i64())
        .unwrap();
    let artifact_owner = nodes
        .iter()
        .find(|node| node["public_id"] == saved.id && node["kind"] == "artifact")
        .and_then(|node| node["owner"].as_i64())
        .unwrap();
    assert_eq!(artifact_owner, workspace_rowid);
}

#[test]
fn session_log_stays_append_only_when_context_window_changes() {
    let uc = UltraContext::open(temp_db("session-log")).unwrap();
    let ctx = uc.create(json!({"name": "session"})).unwrap();

    uc.append(
        &ctx.id,
        vec![
            AppendInput::new(json!({"content": "keep"})),
            AppendInput::new(json!({"content": "remove from context"})),
        ],
    )
    .unwrap();
    uc.delete_messages(&ctx.id, vec![DeleteTarget::Index(1)], json!({}))
        .unwrap();
    uc.append(&ctx.id, vec![AppendInput::new(json!({"content": "new"}))])
        .unwrap();

    let current = uc.get(&ctx.id, GetOptions::default()).unwrap();
    let current_contents = current
        .data
        .iter()
        .map(|message| message.content["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(current_contents, vec!["keep", "new"]);

    let snapshot = uc.export_snapshot().unwrap();
    let nodes = snapshot["nodes"].as_array().unwrap();
    let session = nodes
        .iter()
        .find(|node| node["public_id"] == ctx.id && node["kind"] == "session")
        .unwrap();
    let session_rowid = session["id"].as_i64().unwrap();
    let session_messages = nodes
        .iter()
        .filter(|node| node["kind"] == "message" && node["owner"].as_i64() == Some(session_rowid))
        .map(|node| node["content"]["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(session_messages, vec!["keep", "remove from context", "new"]);

    let context_heads = nodes
        .iter()
        .filter(|node| node["kind"] == "context" && node["owner"].as_i64() == Some(session_rowid))
        .count();
    assert_eq!(context_heads, 2);
}

#[test]
fn artifact_path_is_a_mutable_label_not_identity() {
    let uc = UltraContext::open(temp_db("artifact")).unwrap();
    let ctx = uc.create(json!({})).unwrap();

    let draft = uc
        .save_artifact(
            &ctx.id,
            ArtifactSave::new("draft.md", "text/markdown", "# Draft"),
        )
        .unwrap();
    let renamed = uc
        .save_artifact(
            &ctx.id,
            ArtifactSave::new("final.md", "text/markdown", "# Final")
                .with_id(&draft.id)
                .with_if_version(draft.version),
        )
        .unwrap();

    assert_eq!(renamed.id, draft.id);
    assert_eq!(renamed.path, "final.md");
    assert_eq!(renamed.version, draft.version + 1);

    let current = uc.load_artifact(&ctx.id, "final.md", None).unwrap();
    let previous = uc.load_artifact(&ctx.id, &draft.id, Some(0)).unwrap();

    assert_eq!(current.id, draft.id);
    assert_eq!(current.data.as_deref(), Some("# Final"));
    assert_eq!(previous.path, "draft.md");
    assert_eq!(previous.data.as_deref(), Some("# Draft"));
}

#[test]
fn artifact_writes_can_be_guarded_by_version() {
    let uc = UltraContext::open(temp_db("conflict")).unwrap();
    let ctx = uc.create(json!({})).unwrap();

    let artifact = uc
        .save_artifact(
            &ctx.id,
            ArtifactSave::new("notes.md", "text/markdown", "v1"),
        )
        .unwrap();

    let err = uc
        .save_artifact(
            &ctx.id,
            ArtifactSave::new("notes.md", "text/markdown", "v2")
                .with_if_version(artifact.version + 1),
        )
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.message, "Artifact version conflict");
}

#[test]
fn artifact_paths_are_normalized_and_safe() {
    let uc = UltraContext::open(temp_db("paths")).unwrap();
    let ctx = uc.create(json!({})).unwrap();

    let saved = uc
        .save_artifact(
            &ctx.id,
            ArtifactSave::new("notes//today.md", "text/markdown", "hello"),
        )
        .unwrap();
    assert_eq!(saved.path, "notes/today.md");

    let err = uc
        .save_artifact(
            &ctx.id,
            ArtifactSave::new("../secret.md", "text/markdown", "nope"),
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert_eq!(err.message, "Invalid artifact path");
}

#[test]
fn artifacts_can_store_large_content_in_a_local_directory() {
    let content_root = temp_dir("content-store");
    let uc = UltraContext::open_with_options(
        temp_db("content-store"),
        UltraContextOptions {
            content_store: ContentStore::local_dir(&content_root, 4),
        },
    )
    .unwrap();
    let ctx = uc.create(json!({})).unwrap();

    let saved = uc
        .save_artifact(
            &ctx.id,
            ArtifactSave::new("large.md", "text/markdown", "larger than four bytes"),
        )
        .unwrap();
    let loaded = uc.load_artifact(&ctx.id, "large.md", None).unwrap();

    assert_eq!(loaded.data.as_deref(), Some("larger than four bytes"));
    assert_eq!(loaded.storage["type"], "ref");
    assert_eq!(loaded.storage["driver"], "local-dir");

    let key = loaded.storage["key"].as_str().unwrap();
    let blob_path = content_root.join(key);
    assert!(blob_path.exists());

    uc.delete_artifact_permanently(&saved.id).unwrap();
    assert!(!blob_path.exists());
}

#[test]
fn artifacts_can_store_large_content_in_s3_compatible_storage() {
    let server = MockS3Server::start();
    let uc = UltraContext::open_with_options(
        temp_db("s3-content-store"),
        UltraContextOptions {
            content_store: ContentStore::s3(S3ContentStore {
                endpoint: server.endpoint.clone(),
                bucket: "bucket".to_string(),
                region: "auto".to_string(),
                access_key_id: "test-key".to_string(),
                secret_access_key: "test-secret".to_string(),
                session_token: None,
                prefix: Some("uc-test".to_string()),
                inline_limit: 4,
            }),
        },
    )
    .unwrap();
    let ctx = uc.create(json!({})).unwrap();

    let saved = uc
        .save_artifact(
            &ctx.id,
            ArtifactSave::new("large.md", "text/markdown", "larger than four bytes"),
        )
        .unwrap();
    let loaded = uc.load_artifact(&ctx.id, "large.md", None).unwrap();

    assert_eq!(loaded.data.as_deref(), Some("larger than four bytes"));
    assert_eq!(loaded.storage["type"], "ref");
    assert_eq!(loaded.storage["driver"], "s3");
    assert_eq!(loaded.storage["bucket"], "bucket");
    assert_eq!(loaded.storage["region"], "auto");
    assert!(
        loaded.storage["key"]
            .as_str()
            .unwrap()
            .starts_with("uc-test/artifacts/art_")
    );

    uc.delete_artifact_permanently(&saved.id).unwrap();
    server.join();
}

#[test]
fn artifacts_can_be_loaded_as_exact_bytes() {
    let uc = UltraContext::open(temp_db("artifact-bytes")).unwrap();
    let ctx = uc.create(json!({})).unwrap();
    let data = vec![0, 159, 146, 150, 255, 10];

    uc.save_artifact(
        &ctx.id,
        ArtifactSave::new("images/raw.bin", "application/octet-stream", &data),
    )
    .unwrap();

    let loaded = uc
        .load_artifact_bytes(&ctx.id, "images/raw.bin", None)
        .unwrap();

    assert_eq!(loaded.data, data);
    assert_eq!(loaded.kind, "application/octet-stream");
}

#[test]
fn snapshots_can_mirror_nodes_and_blob_content_into_a_new_store() {
    let content_root = temp_dir("snapshot-content");
    let source = UltraContext::open_with_options(
        temp_db("snapshot-source"),
        UltraContextOptions {
            content_store: ContentStore::local_dir(&content_root, 4),
        },
    )
    .unwrap();
    let ctx = source.create(json!({"mirror": "source"})).unwrap();
    source
        .append(
            &ctx.id,
            vec![AppendInput::new(json!({"content": "mirror me"}))],
        )
        .unwrap();
    source
        .save_artifact(
            &ctx.id,
            ArtifactSave::new("mirror.md", "text/markdown", "mirrored blob content"),
        )
        .unwrap();

    let snapshot = source.export_snapshot().unwrap();
    let mirror = UltraContext::open(temp_db("snapshot-mirror")).unwrap();
    mirror.import_snapshot(snapshot).unwrap();

    let mirrored_context = mirror.get(&ctx.id, GetOptions::default()).unwrap();
    assert_eq!(mirrored_context.data[0].content["content"], "mirror me");
    let mirrored_artifact = mirror.load_artifact(&ctx.id, "mirror.md", None).unwrap();
    assert_eq!(
        mirrored_artifact.data.as_deref(),
        Some("mirrored blob content")
    );
    assert_eq!(mirrored_artifact.storage["type"], "inline");
}

#[test]
fn incremental_changes_can_sync_from_a_shared_cursor_and_report_conflicts() {
    let source = UltraContext::open(temp_db("changes-source")).unwrap();
    let mirror = UltraContext::open(temp_db("changes-mirror")).unwrap();
    let ctx = source.create(json!({"sync": "source"})).unwrap();
    source
        .append(&ctx.id, vec![AppendInput::new(json!({"content": "base"}))])
        .unwrap();

    let snapshot = source.export_snapshot().unwrap();
    let cursor = snapshot["cursor"].as_i64().unwrap();
    mirror.import_snapshot(snapshot).unwrap();

    source
        .append(&ctx.id, vec![AppendInput::new(json!({"content": "next"}))])
        .unwrap();
    source
        .save_artifact(
            &ctx.id,
            ArtifactSave::new("sync.md", "text/markdown", "synced content"),
        )
        .unwrap();

    let changes = source.export_changes(Some(cursor)).unwrap();
    assert_eq!(changes["schema"], "ultracontext.changes.v1");
    assert!(changes["cursor"].as_i64().unwrap() > cursor);

    let imported = mirror.import_changes(changes.clone()).unwrap();
    assert!(imported["imported"].as_u64().unwrap() > 0);
    assert_eq!(imported["conflicts"].as_array().unwrap().len(), 0);

    let mirrored = mirror.get(&ctx.id, GetOptions::default()).unwrap();
    assert_eq!(mirrored.data[1].content["content"], "next");
    let artifact = mirror.load_artifact(&ctx.id, "sync.md", None).unwrap();
    assert_eq!(artifact.data.as_deref(), Some("synced content"));

    let repeated = mirror.import_changes(changes.clone()).unwrap();
    assert!(repeated["skipped"].as_u64().unwrap() > 0);
    assert_eq!(repeated["conflicts"].as_array().unwrap().len(), 0);

    let mut conflicting = changes;
    conflicting["nodes"][0]["public_id"] = json!("ctx_conflicting");
    let report = mirror.import_changes(conflicting).unwrap();
    assert_eq!(report["conflicts"].as_array().unwrap().len(), 1);
}

#[test]
fn artifacts_can_be_listed_searched_and_deleted() {
    let uc = UltraContext::open(temp_db("artifact-list")).unwrap();
    let ctx = uc.create(json!({"name": "search"})).unwrap();

    uc.append(
        &ctx.id,
        vec![AppendInput::new(json!({
            "role": "user",
            "content": "please draft a launch note"
        }))],
    )
    .unwrap();

    let artifact = uc
        .save_artifact(
            &ctx.id,
            ArtifactSave::new("launch.md", "text/markdown", "initial launch note"),
        )
        .unwrap();
    uc.save_artifact(
        &ctx.id,
        ArtifactSave::new("launch.md", "text/markdown", "final launch note")
            .with_if_version(artifact.version),
    )
    .unwrap();

    let artifacts = uc.list_artifacts(&ctx.id).unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].path, "launch.md");
    assert_eq!(artifacts[0].version, 1);

    let search = uc.search("launch").unwrap();
    assert_eq!(search.data.len(), 2);
    assert!(
        search
            .data
            .iter()
            .any(|hit| hit.kind == SearchKind::Message && hit.context_id == ctx.id)
    );
    assert!(search.data.iter().any(|hit| {
        hit.kind == SearchKind::Artifact
            && hit.context_id == ctx.id
            && hit.path.as_deref() == Some("launch.md")
            && hit.snippet.contains("final launch note")
    }));
    assert!(
        !search
            .data
            .iter()
            .any(|hit| hit.snippet.contains("initial launch note"))
    );

    uc.delete_artifact_permanently(&artifact.id).unwrap();
    let err = uc.load_artifact(&ctx.id, "launch.md", None).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[test]
fn fork_copies_the_selected_context_version_and_current_artifacts() {
    let uc = UltraContext::open(temp_db("fork")).unwrap();
    let ctx = uc.create(json!({"name": "source"})).unwrap();
    uc.append(
        &ctx.id,
        vec![
            AppendInput::new(json!({"content": "first"})),
            AppendInput::new(json!({"content": "second"})),
        ],
    )
    .unwrap();
    uc.update_message(
        &ctx.id,
        UpdatePatch::by_index(1, json!({"content": "second patched"})),
        json!({}),
    )
    .unwrap();
    uc.save_artifact(
        &ctx.id,
        ArtifactSave::new("draft.md", "text/markdown", "current artifact"),
    )
    .unwrap();

    let fork = uc
        .fork(
            &ctx.id,
            ForkOptions {
                version: Some(0),
                metadata: json!({"name": "fork"}),
            },
        )
        .unwrap();

    let forked = uc.get(&fork.id, GetOptions::default()).unwrap();
    assert_eq!(forked.version, 0);
    assert_eq!(forked.data.len(), 2);
    assert_eq!(forked.data[1].content["content"], "second");

    let artifact = uc.load_artifact(&fork.id, "draft.md", None).unwrap();
    assert_eq!(artifact.data.as_deref(), Some("current artifact"));
}

#[test]
fn soft_delete_creates_a_new_recoverable_context_version() {
    let uc = UltraContext::open(temp_db("soft-delete")).unwrap();
    let ctx = uc.create(json!({})).unwrap();
    uc.append(
        &ctx.id,
        vec![
            AppendInput::new(json!({"content": "keep"})),
            AppendInput::new(json!({"content": "remove"})),
        ],
    )
    .unwrap();

    let deleted = uc
        .delete_messages(
            &ctx.id,
            vec![DeleteTarget::Index(1)],
            json!({"reason": "cleanup"}),
        )
        .unwrap();

    assert_eq!(deleted.version, 1);
    assert_eq!(deleted.data.len(), 1);
    assert_eq!(deleted.data[0].content["content"], "keep");

    let old = uc.get(&ctx.id, GetOptions { version: Some(0) }).unwrap();
    assert_eq!(old.data.len(), 2);
    assert_eq!(old.data[1].content["content"], "remove");
}

#[test]
fn permanent_session_delete_scrubs_session_data_and_preserves_workspace_artifacts() {
    let uc = UltraContext::open(temp_db("context-delete")).unwrap();
    let ctx = uc.create(json!({})).unwrap();
    uc.append(&ctx.id, vec![AppendInput::new(json!({"content": "bye"}))])
        .unwrap();
    uc.save_artifact(&ctx.id, ArtifactSave::new("bye.md", "text/markdown", "bye"))
        .unwrap();

    uc.delete_context_permanently(&ctx.id).unwrap();

    let err = uc.get(&ctx.id, GetOptions::default()).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    let err = uc.load_artifact(&ctx.id, "bye.md", None).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);

    let artifacts = uc.list_workspace_artifacts("ws_default").unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].path, "bye.md");
}

#[test]
fn file_verbs_project_paths_over_artifacts() {
    let uc = UltraContext::open(temp_db("file-verbs")).unwrap();
    let ctx = uc.create(json!({})).unwrap();

    let written = uc
        .file_write(
            &ctx.id,
            FileWrite::new("notes/today.md", "hello").with_kind("text/markdown"),
        )
        .unwrap();
    let read = uc.file_read(&ctx.id, "notes/today.md").unwrap();
    assert_eq!(read.data.as_deref(), Some("hello"));

    let moved = uc
        .file_move(
            &ctx.id,
            "notes/today.md",
            "archive/today.md",
            Some(written.version),
        )
        .unwrap();
    assert_eq!(moved.id, written.id);
    assert_eq!(moved.path, "archive/today.md");

    let files = uc.file_list(&ctx.id, Some("archive/")).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "archive/today.md");

    let grep = uc.file_grep(&ctx.id, "hello", Some("archive/")).unwrap();
    assert_eq!(grep.data.len(), 1);
    assert_eq!(grep.data[0].path.as_deref(), Some("archive/today.md"));

    uc.file_remove(&ctx.id, "archive/today.md", Some(moved.version))
        .unwrap();
    let err = uc.file_read(&ctx.id, "archive/today.md").unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}
