//! JSON operation router: maps `(operation, input)` to typed engine calls and serializes back.

use serde_json::{Value, json};

use crate::UltraContext;
use crate::error::{ErrorCode, UcError, UcResult};
use crate::views::{
    AppendInput, ArtifactSave, DeleteTarget, FileWrite, ForkOptions, GetOptions, UpdatePatch,
    UpdateTarget, artifact_data_json, artifact_meta_json, context_data_json, context_history_json,
    context_view_json, mutation_result_json, search_result_json, session_view_json,
    workspace_view_json,
};

impl UltraContext {
    pub fn dispatch_json_str(&self, operation: &str, input: &str) -> UcResult<String> {
        let input = serde_json::from_str(input)
            .map_err(|_| UcError::new(ErrorCode::InvalidInput, "Input must be valid JSON"))?;
        Ok(self.dispatch_json(operation, input)?.to_string())
    }

    pub fn dispatch_json(&self, operation: &str, input: Value) -> UcResult<Value> {
        match operation {
            "create" => {
                let metadata = input.get("metadata").cloned().unwrap_or_else(|| json!({}));
                if let Some(workspace_id) = optional_str(&input, &["workspaceId"])? {
                    Ok(context_view_json(
                        &self.create_in_workspace(workspace_id, metadata)?,
                    ))
                } else {
                    Ok(context_view_json(&self.create(metadata)?))
                }
            }
            "create_workspace" => {
                Ok(workspace_view_json(&self.create_workspace(
                    input.get("metadata").cloned().unwrap_or_else(|| json!({})),
                )?))
            }
            "list_workspaces" => Ok(json!({
                "data": self
                    .list_workspaces()?
                    .into_iter()
                    .map(|view| workspace_view_json(&view))
                    .collect::<Vec<_>>()
            })),
            "create_session" => Ok(session_view_json(&self.create_session(
                required_str(&input, &["workspaceId"])?,
                input.get("metadata").cloned().unwrap_or_else(|| json!({})),
            )?)),
            "fork" => Ok(context_view_json(&self.fork(
                required_str(&input, &["sourceId"])?,
                ForkOptions {
                    version: optional_usize(&input, &["version"])?,
                    metadata: input.get("metadata").cloned().unwrap_or_else(|| json!({})),
                },
            )?)),
            "append" => {
                let ctx_id = required_str(&input, &["ctxId"])?;
                let messages = array_or_single(required_value(&input, &["messages"])?)
                    .iter()
                    .cloned()
                    .map(|message| {
                        let metadata = message
                            .get("metadata")
                            .cloned()
                            .unwrap_or_else(|| json!({}));
                        AppendInput::new(message).with_metadata(metadata)
                    })
                    .collect();
                Ok(mutation_result_json(&self.append(ctx_id, messages)?))
            }
            "get" => Ok(context_data_json(&self.get(
                required_str(&input, &["ctxId"])?,
                GetOptions {
                    version: optional_usize(&input, &["version"])?,
                },
            )?)),
            "context_history" => Ok(context_history_json(
                &self.context_history(required_str(&input, &["ctxId"])?)?,
            )),
            "context_clear" => Ok(mutation_result_json(&self.clear_context(
                required_str(&input, &["ctxId"])?,
                input.get("metadata").cloned().unwrap_or_else(|| json!({})),
            )?)),
            "context_restore" => Ok(mutation_result_json(&self.restore_context(
                required_str(&input, &["ctxId"])?,
                required_str(&input, &["restoreContextId"])?,
                input.get("metadata").cloned().unwrap_or_else(|| json!({})),
            )?)),
            "list_contexts" => Ok(json!({
                "data": self
                    .list_contexts()?
                    .into_iter()
                    .map(|view| context_view_json(&view))
                    .collect::<Vec<_>>()
            })),
            "update" => {
                let ctx_id = required_str(&input, &["ctxId"])?;
                let update = first_update(&input)?;
                let patch = parse_update_patch(update)?;
                Ok(mutation_result_json(&self.update_message(
                    ctx_id,
                    patch,
                    input.get("metadata").cloned().unwrap_or_else(|| json!({})),
                )?))
            }
            "delete" => {
                let ctx_id = required_str(&input, &["ctxId"])?;
                if input
                    .get("target")
                    .and_then(|target| target.get("permanent"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    self.delete_context_permanently(ctx_id)?;
                    return Ok(json!({"deleted": true, "id": ctx_id}));
                }
                let targets = parse_delete_targets(&input)?;
                Ok(mutation_result_json(&self.delete_messages(
                    ctx_id,
                    targets,
                    input.get("metadata").cloned().unwrap_or_else(|| json!({})),
                )?))
            }
            "delete_messages" => {
                let ctx_id = required_str(&input, &["ctxId"])?;
                let targets = parse_delete_targets(&input)?;
                Ok(mutation_result_json(&self.delete_messages(
                    ctx_id,
                    targets,
                    input.get("metadata").cloned().unwrap_or_else(|| json!({})),
                )?))
            }
            "delete_context" => {
                let ctx_id = required_str(&input, &["ctxId"])?;
                self.delete_context_permanently(ctx_id)?;
                Ok(json!({"deleted": true, "id": ctx_id}))
            }
            "save" => {
                let ctx_id = required_str(&input, &["ctxId"])?;
                Ok(artifact_meta_json(
                    &self.save_artifact(ctx_id, artifact_save_from_json(&input)?)?,
                ))
            }
            "load" => Ok(artifact_data_json(&self.load_artifact(
                required_str(&input, &["ctxId"])?,
                required_str(&input, &["pathOrId"])?,
                optional_usize(&input, &["version"])?,
            )?)),
            "list_artifacts" => Ok(json!({
                "data": self
                    .list_artifacts(required_str(&input, &["ctxId"])?)?
                    .into_iter()
                    .map(|view| artifact_meta_json(&view))
                    .collect::<Vec<_>>()
            })),
            "search" => Ok(search_result_json(
                &self.search(required_str(&input, &["query"])?)?,
            )),
            "file_write" | "write" => {
                let ctx_id = required_str(&input, &["ctxId"])?;
                Ok(artifact_meta_json(
                    &self.file_write(ctx_id, file_write_from_json(&input)?)?,
                ))
            }
            "file_read" | "read" => Ok(artifact_data_json(&self.load_artifact(
                required_str(&input, &["ctxId"])?,
                required_str(&input, &["pathOrId"])?,
                optional_usize(&input, &["version"])?,
            )?)),
            "file_move" | "move" => {
                let ctx_id = required_str(&input, &["ctxId"])?;
                Ok(artifact_meta_json(&self.file_move(
                    ctx_id,
                    required_str(&input, &["fromPathOrId"])?,
                    required_str(&input, &["toPath"])?,
                    optional_usize(&input, &["ifVersion"])?,
                )?))
            }
            "file_list" | "list" => Ok(json!({
                "data": self
                    .file_list(
                        required_str(&input, &["ctxId"])?,
                        optional_str(&input, &["prefix"])?
                    )?
                    .into_iter()
                    .map(|view| artifact_meta_json(&view))
                    .collect::<Vec<_>>()
            })),
            "file_glob" | "glob" => Ok(json!({
                "data": self
                    .file_glob(
                        required_str(&input, &["ctxId"])?,
                        required_str(&input, &["pattern"])?
                    )?
                    .into_iter()
                    .map(|view| artifact_meta_json(&view))
                    .collect::<Vec<_>>()
            })),
            "file_grep" | "grep" => Ok(search_result_json(&self.file_grep(
                required_str(&input, &["ctxId"])?,
                required_str(&input, &["query"])?,
                optional_str(&input, &["prefix"])?,
            )?)),
            "file_remove" | "remove" => {
                let ctx_id = required_str(&input, &["ctxId"])?;
                let path_or_id = required_str(&input, &["pathOrId"])?;
                self.file_remove(ctx_id, path_or_id, optional_usize(&input, &["ifVersion"])?)?;
                Ok(json!({"deleted": true, "id": path_or_id}))
            }
            "export_snapshot" => self.export_snapshot(),
            "import_snapshot" => self.import_snapshot(input),
            "export_changes" => self.export_changes(optional_i64(&input, "since")?),
            "import_changes" => self.import_changes(input),
            _ => Err(UcError::new(
                ErrorCode::InvalidInput,
                format!("Unknown operation: {operation}"),
            )),
        }
    }
}

fn first_update(input: &Value) -> UcResult<&Value> {
    let updates = required_value(input, &["updates", "update"])?;
    if let Some(values) = updates.as_array() {
        values
            .first()
            .ok_or_else(|| UcError::new(ErrorCode::InvalidInput, "Pass at least one update"))
    } else {
        Ok(updates)
    }
}

fn parse_update_patch(input: &Value) -> UcResult<UpdatePatch> {
    let Value::Object(map) = input else {
        return Err(UcError::new(
            ErrorCode::InvalidInput,
            "Update must be an object",
        ));
    };

    let target = if let Some(index) = map.get("index").and_then(Value::as_i64) {
        UpdateTarget::Index(index as isize)
    } else if let Some(id) = map.get("id").and_then(Value::as_str) {
        UpdateTarget::Id(id.to_string())
    } else {
        return Err(UcError::new(
            ErrorCode::InvalidInput,
            "Update must include id or index",
        ));
    };

    let mut content = map.clone();
    content.remove("id");
    content.remove("index");
    Ok(UpdatePatch {
        target,
        content: Value::Object(content),
    })
}

fn parse_delete_targets(input: &Value) -> UcResult<Vec<DeleteTarget>> {
    let target = required_value(input, &["targets", "target"])?;
    let values = if let Some(values) = target.as_array() {
        values
    } else {
        return parse_delete_target(target).map(|target| vec![target]);
    };

    if values.is_empty() {
        return Err(UcError::new(
            ErrorCode::InvalidInput,
            "Pass at least one message id or index",
        ));
    }

    values.iter().map(parse_delete_target).collect()
}

fn parse_delete_target(input: &Value) -> UcResult<DeleteTarget> {
    if let Some(index) = input.as_i64() {
        return Ok(DeleteTarget::Index(index as isize));
    }
    if let Some(id) = input.as_str() {
        return Ok(DeleteTarget::Id(id.to_string()));
    }
    if let Some(index) = input.get("index").and_then(Value::as_i64) {
        return Ok(DeleteTarget::Index(index as isize));
    }
    if let Some(id) = input.get("id").and_then(Value::as_str) {
        return Ok(DeleteTarget::Id(id.to_string()));
    }
    Err(UcError::new(
        ErrorCode::InvalidInput,
        "Delete target must be an id or index",
    ))
}

fn artifact_save_from_json(input: &Value) -> UcResult<ArtifactSave> {
    Ok(ArtifactSave {
        id: optional_str(input, &["id"])?.map(ToOwned::to_owned),
        path: required_str(input, &["path"])?.to_string(),
        kind: optional_str(input, &["kind"])?
            .unwrap_or("text/plain")
            .to_string(),
        data: value_to_bytes(input.get("data").unwrap_or(&Value::Null)),
        metadata: input.get("metadata").cloned().unwrap_or_else(|| json!({})),
        if_version: optional_usize(input, &["ifVersion"])?,
    })
}

fn file_write_from_json(input: &Value) -> UcResult<FileWrite> {
    Ok(FileWrite {
        path: required_str(input, &["path"])?.to_string(),
        kind: optional_str(input, &["kind"])?
            .unwrap_or("text/plain")
            .to_string(),
        data: value_to_bytes(input.get("data").unwrap_or(&Value::Null)),
        metadata: input.get("metadata").cloned().unwrap_or_else(|| json!({})),
        if_version: optional_usize(input, &["ifVersion"])?,
    })
}

fn value_to_bytes(value: &Value) -> Vec<u8> {
    match value {
        Value::Null => Vec::new(),
        Value::String(value) => value.as_bytes().to_vec(),
        value => value.to_string().into_bytes(),
    }
}

fn required_value<'a>(input: &'a Value, keys: &[&str]) -> UcResult<&'a Value> {
    keys.iter().find_map(|key| input.get(*key)).ok_or_else(|| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("Missing field: {}", keys[0]),
        )
    })
}

fn array_or_single(value: &Value) -> Vec<Value> {
    if let Some(values) = value.as_array() {
        values.clone()
    } else {
        vec![value.clone()]
    }
}

pub(crate) fn required_str<'a>(input: &'a Value, keys: &[&str]) -> UcResult<&'a str> {
    required_value(input, keys)?.as_str().ok_or_else(|| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("Field must be a string: {}", keys[0]),
        )
    })
}

fn optional_str<'a>(input: &'a Value, keys: &[&str]) -> UcResult<Option<&'a str>> {
    let Some(value) = keys.iter().find_map(|key| input.get(*key)) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value.as_str().map(Some).ok_or_else(|| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("Field must be a string: {}", keys[0]),
        )
    })
}

fn optional_usize(input: &Value, keys: &[&str]) -> UcResult<Option<usize>> {
    let Some(value) = keys.iter().find_map(|key| input.get(*key)) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_u64()
        .map(|value| Some(value as usize))
        .ok_or_else(|| {
            UcError::new(
                ErrorCode::InvalidInput,
                format!("Field must be a positive integer: {}", keys[0]),
            )
        })
}

pub(crate) fn optional_i64(input: &Value, key: &str) -> UcResult<Option<i64>> {
    let Some(value) = input.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value.as_i64().map(Some).ok_or_else(|| {
        UcError::new(
            ErrorCode::InvalidInput,
            format!("Field must be an integer: {key}"),
        )
    })
}
