use serde_json::json;
use ultracontext::{ErrorCode, UltraContext};

fn temp_db(name: &str) -> String {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "ultracontext-json-{name}-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    path.to_string_lossy().into_owned()
}

#[test]
fn json_dispatch_exposes_sdk_shapes_over_core_logic() {
    let uc = UltraContext::open(temp_db("happy-path")).unwrap();

    let ctx = uc
        .dispatch_json("create", json!({"metadata": {"app": "demo"}}))
        .unwrap();
    let ctx_id = ctx["id"].as_str().unwrap();

    let appended = uc
        .dispatch_json(
            "append",
            json!({
                "ctxId": ctx_id,
                "messages": {"role": "user", "content": "draft this"}
            }),
        )
        .unwrap();
    assert_eq!(appended["version"], 0);
    assert_eq!(appended["data"][0]["role"], "user");
    assert_eq!(appended["data"][0]["content"], "draft this");

    let updated = uc
        .dispatch_json(
            "update",
            json!({
                "ctxId": ctx_id,
                "updates": {"index": 0, "content": "draft that"}
            }),
        )
        .unwrap();
    assert_eq!(updated["version"], 1);
    assert_eq!(updated["data"][0]["content"], "draft that");
    let updated_context_id = updated["context_id"].as_str().unwrap().to_string();

    let deleted = uc
        .dispatch_json("delete", json!({"ctxId": ctx_id, "target": {"index": 0}}))
        .unwrap();
    assert_eq!(deleted["version"], 2);
    assert_eq!(deleted["data"].as_array().unwrap().len(), 0);

    let history = uc
        .dispatch_json("context_history", json!({"ctxId": ctx_id}))
        .unwrap();
    assert_eq!(history["data"].as_array().unwrap().len(), 3);
    assert_eq!(history["data"][2]["operation"], "delete");

    let cleared = uc
        .dispatch_json(
            "context_clear",
            json!({"ctxId": ctx_id, "metadata": {"reason": "reset"}}),
        )
        .unwrap();
    assert_eq!(cleared["version"], 3);
    assert_eq!(cleared["data"].as_array().unwrap().len(), 0);

    let restored = uc
        .dispatch_json(
            "context_restore",
            json!({
                "ctxId": ctx_id,
                "restoreContextId": updated_context_id,
                "metadata": {"reason": "time travel"}
            }),
        )
        .unwrap();
    assert_eq!(restored["version"], 4);
    assert_eq!(restored["data"][0]["content"], "draft that");

    let written = uc
        .dispatch_json(
            "file_write",
            json!({
                "ctxId": ctx_id,
                "path": "draft.md",
                "kind": "text/markdown",
                "data": "# Draft"
            }),
        )
        .unwrap();
    assert_eq!(written["path"], "draft.md");
    assert_eq!(written["version"], 0);

    let moved = uc
        .dispatch_json(
            "file_move",
            json!({
                "ctxId": ctx_id,
                "fromPathOrId": "draft.md",
                "toPath": "final.md",
                "ifVersion": written["version"]
            }),
        )
        .unwrap();
    assert_eq!(moved["id"], written["id"]);
    assert_eq!(moved["path"], "final.md");

    let read = uc
        .dispatch_json(
            "file_read",
            json!({"ctxId": ctx_id, "pathOrId": "final.md"}),
        )
        .unwrap();
    assert_eq!(read["data"], "# Draft");
    assert_eq!(read["version"], 1);

    let files = uc
        .dispatch_json("file_list", json!({"ctxId": ctx_id, "prefix": "final"}))
        .unwrap();
    assert_eq!(files["data"].as_array().unwrap().len(), 1);
    assert_eq!(files["data"][0]["path"], "final.md");

    let glob = uc
        .dispatch_json("file_glob", json!({"ctxId": ctx_id, "pattern": "final*"}))
        .unwrap();
    assert_eq!(glob["data"][0]["path"], "final.md");

    let grep = uc
        .dispatch_json(
            "file_grep",
            json!({"ctxId": ctx_id, "query": "Draft", "prefix": ""}),
        )
        .unwrap();
    assert_eq!(grep["data"][0]["kind"], "artifact");
    assert_eq!(grep["data"][0]["path"], "final.md");

    let listed = uc.dispatch_json("list_contexts", json!({})).unwrap();
    assert_eq!(listed["data"][0]["id"], ctx_id);
}

#[test]
fn json_dispatch_exposes_workspace_and_session_shapes() {
    let uc = UltraContext::open(temp_db("workspace-session")).unwrap();

    let workspace = uc
        .dispatch_json("create_workspace", json!({"metadata": {"name": "project"}}))
        .unwrap();
    let workspace_id = workspace["id"].as_str().unwrap();

    let session = uc
        .dispatch_json(
            "create_session",
            json!({
                "workspaceId": workspace_id,
                "metadata": {"name": "run"}
            }),
        )
        .unwrap();
    assert_eq!(session["workspace_id"], workspace_id);
    assert!(session["id"].as_str().unwrap().starts_with("ses_"));
    assert!(session["context_id"].as_str().unwrap().starts_with("ctx_"));

    let ctx = uc
        .dispatch_json(
            "create",
            json!({
                "workspaceId": workspace_id,
                "metadata": {"name": "simple"}
            }),
        )
        .unwrap();
    assert!(ctx["id"].as_str().unwrap().starts_with("ses_"));

    let workspaces = uc.dispatch_json("list_workspaces", json!({})).unwrap();
    assert_eq!(workspaces["data"].as_array().unwrap().len(), 1);
}

#[test]
fn json_dispatch_preserves_stable_error_codes() {
    let uc = UltraContext::open(temp_db("errors")).unwrap();

    let err = uc
        .dispatch_json_str("create", "{not json")
        .expect_err("invalid JSON should fail");
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert_eq!(err.code_str(), "invalid_input");
    assert_eq!(err.to_json()["code"], "invalid_input");

    let err = uc
        .dispatch_json("get", json!({"ctxId": "ctx_missing"}))
        .expect_err("missing context should fail");
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.code_str(), "not_found");

    let err = uc
        .dispatch_json("nope", json!({}))
        .expect_err("unknown operation should fail");
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert_eq!(err.code_str(), "invalid_input");
}
