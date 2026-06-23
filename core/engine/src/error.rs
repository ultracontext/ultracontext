//! Error codes and the unified `UcError` returned across the whole core.

use serde_json::{Value, json};

pub type UcResult<T> = std::result::Result<T, UcError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorCode {
    NotFound,
    InvalidInput,
    Conflict,
    Busy,
    IncompatibleDb,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UcError {
    pub code: ErrorCode,
    pub message: String,
}

impl UcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code_str(&self) -> &'static str {
        self.code.as_str()
    }

    pub fn to_json(&self) -> Value {
        json!({
            "code": self.code.as_str(),
            "message": self.message
        })
    }
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::NotFound => "not_found",
            ErrorCode::InvalidInput => "invalid_input",
            ErrorCode::Conflict => "conflict",
            ErrorCode::Busy => "busy",
            ErrorCode::IncompatibleDb => "incompatible_db",
            ErrorCode::Internal => "internal",
        }
    }
}

impl From<rusqlite::Error> for UcError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::SqliteFailure(ref inner, _)
                if inner.code == rusqlite::ErrorCode::DatabaseBusy =>
            {
                UcError::new(ErrorCode::Busy, "Database busy")
            }
            _ => UcError::new(ErrorCode::Internal, error.to_string()),
        }
    }
}
