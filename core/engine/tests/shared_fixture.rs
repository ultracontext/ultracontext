use serde_json::{Value, json};
use ultracontext::{ErrorCode, UltraContext};

fn temp_db(name: &str) -> String {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "ultracontext-shared-{name}-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    path.to_string_lossy().into_owned()
}

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/v2-alpha.json")).unwrap()
}

#[test]
fn shared_v2_alpha_fixture_passes_through_json_dispatch() {
    let f = fixture();
    let uc = UltraContext::open(temp_db("core")).unwrap();

    let ctx = uc
        .dispatch_json("create", json!({"metadata": f["metadata"]}))
        .unwrap();
    let ctx_id = ctx["id"].as_str().unwrap();

    let appended = uc
        .dispatch_json(
            "append",
            json!({"ctxId": ctx_id, "messages": f["messages"]}),
        )
        .unwrap();
    assert_eq!(appended["version"], 0);
    assert_eq!(appended["data"].as_array().unwrap().len(), 2);

    let updated = uc
        .dispatch_json(
            "update",
            json!({"ctxId": ctx_id, "updates": f["message_update"]}),
        )
        .unwrap();
    assert_eq!(updated["version"], 1);
    assert_eq!(updated["data"][1]["content"], "fixture draft ready!");

    let fork = uc
        .dispatch_json(
            "fork",
            json!({"sourceId": ctx_id, "version": 0, "metadata": {"suite": "fork"}}),
        )
        .unwrap();
    let forked = uc
        .dispatch_json("get", json!({"ctxId": fork["id"], "version": 0}))
        .unwrap();
    assert_eq!(forked["data"][1]["content"], "fixture draft ready");

    let written = uc
        .dispatch_json(
            "file_write",
            json!({
                "ctxId": ctx_id,
                "path": f["artifact"]["path"],
                "kind": f["artifact"]["kind"],
                "data": f["artifact"]["initial"]
            }),
        )
        .unwrap();
    assert_eq!(written["version"], 0);

    let conflict = uc
        .dispatch_json(
            "file_write",
            json!({
                "ctxId": ctx_id,
                "path": f["artifact"]["path"],
                "kind": f["artifact"]["kind"],
                "data": f["artifact"]["final"],
                "ifVersion": written["version"].as_u64().unwrap() + 1
            }),
        )
        .unwrap_err();
    assert_eq!(conflict.code, ErrorCode::Conflict);

    let saved = uc
        .dispatch_json(
            "save",
            json!({
                "ctxId": ctx_id,
                "id": written["id"],
                "path": f["artifact"]["renamed_path"],
                "kind": f["artifact"]["kind"],
                "data": f["artifact"]["final"],
                "ifVersion": written["version"]
            }),
        )
        .unwrap();
    assert_eq!(saved["id"], written["id"]);
    assert_eq!(saved["version"], 1);

    let old = uc
        .dispatch_json(
            "file_read",
            json!({"ctxId": ctx_id, "pathOrId": written["id"], "version": 0}),
        )
        .unwrap();
    assert_eq!(old["path"], f["artifact"]["path"]);
    assert_eq!(old["data"], f["artifact"]["initial"]);

    let files = uc
        .dispatch_json("file_list", json!({"ctxId": ctx_id, "prefix": "notes"}))
        .unwrap();
    assert_eq!(files["data"][0]["path"], f["artifact"]["renamed_path"]);

    let glob = uc
        .dispatch_json(
            "file_glob",
            json!({"ctxId": ctx_id, "pattern": "notes/*.md"}),
        )
        .unwrap();
    assert_eq!(glob["data"].as_array().unwrap().len(), 1);

    let grep = uc
        .dispatch_json(
            "file_grep",
            json!({"ctxId": ctx_id, "query": f["search_query"], "prefix": "notes"}),
        )
        .unwrap();
    assert_eq!(grep["data"][0]["kind"], "artifact");

    let search = uc
        .dispatch_json("search", json!({"query": f["search_query"]}))
        .unwrap();
    assert!(
        search["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|hit| hit["kind"] == "message")
    );

    uc.dispatch_json(
        "file_remove",
        json!({"ctxId": ctx_id, "pathOrId": f["artifact"]["renamed_path"], "ifVersion": saved["version"]}),
    )
    .unwrap();
    let missing_artifact = uc
        .dispatch_json(
            "file_read",
            json!({"ctxId": ctx_id, "pathOrId": f["artifact"]["renamed_path"]}),
        )
        .unwrap_err();
    assert_eq!(missing_artifact.code, ErrorCode::NotFound);

    let missing_context = uc
        .dispatch_json("get", json!({"ctxId": f["missing_context"]}))
        .unwrap_err();
    assert_eq!(missing_context.code, ErrorCode::NotFound);
}
