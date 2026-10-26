//! Terminal output: ANSI colors (TTY + no NO_COLOR only), aligned tables, relative times,
//! JSON documents, and the CLI error type with exit codes.

use serde::Serialize;
use std::fmt;
use std::io::{IsTerminal, Write};
use std::sync::OnceLock;

use crate::client::control::{self, CtlError};

// ---------------------------------------------------------------- errors / exit codes

pub const EXIT_OK: i32 = 0;
pub const EXIT_ERR: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_BUSY: i32 = 3;

/// An error the CLI reports as `uc: <msg>` + `hint: ...` (or a JSON error document).
#[derive(Debug, Clone, PartialEq)]
pub struct CliError {
    pub exit: i32,
    pub code: String,
    pub msg: String,
    pub hint: Option<String>,
}

impl CliError {
    pub fn new(code: &str, msg: impl Into<String>) -> Self {
        CliError {
            exit: EXIT_ERR,
            code: code.into(),
            msg: msg.into(),
            hint: None,
        }
    }
    pub fn usage(msg: impl Into<String>) -> Self {
        CliError {
            exit: EXIT_USAGE,
            ..CliError::new("usage", msg)
        }
    }
    pub fn hint(mut self, h: impl Into<String>) -> Self {
        self.hint = Some(h.into());
        self
    }
    pub fn exit(mut self, code: i32) -> Self {
        self.exit = code;
        self
    }

    /// Map any error to what the user sees.
    pub fn from_anyhow(e: &anyhow::Error) -> CliError {
        if let Some(c) = e.chain().find_map(|c| c.downcast_ref::<CliError>()) {
            return c.clone();
        }
        if let Some(c) = control::ctl_error(e) {
            return CliError::from_ctl(c);
        }
        CliError::new("error", format!("{e:#}"))
    }

    pub fn from_ctl(c: &CtlError) -> CliError {
        let e = CliError::new(&c.code, c.msg.clone());
        match c.code.as_str() {
            "conflict" => e
                .exit(EXIT_BUSY)
                .hint("run 'uc conflicts' to see what collided"),
            "offline" => e.hint("the hub is unreachable; run 'uc doctor'"),
            "unreachable" | "timeout" => e.hint(format!(
                "start it with 'uc daemon start' (log: {})",
                crate::paths::tilde(&crate::paths::Paths::from_env().daemon_log())
            )),
            "invalid" => e.exit(EXIT_USAGE),
            "restart_required" => e.hint("uc daemon stop && uc daemon start"),
            _ => e,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for CliError {}

#[derive(Serialize)]
struct ErrorDoc<'a> {
    error: ErrorBody<'a>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<&'a str>,
    exit_code: i32,
}

pub fn print_error(e: &CliError, json: bool) {
    if json {
        emit_json(&ErrorDoc {
            error: ErrorBody {
                code: &e.code,
                message: &e.msg,
                hint: e.hint.as_deref(),
                exit_code: e.exit,
            },
        });
        return;
    }
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{} {}", paint_err(Color::Red, "uc:"), e.msg);
    if let Some(h) = &e.hint {
        let _ = writeln!(err, "{} {h}", paint_err(Color::Dim, "hint:"));
    }
}

// ---------------------------------------------------------------- stdout

/// Write to stdout; a closed pipe (`uc sessions | head`) ends the process quietly.
pub fn write_stdout(s: &str) {
    let mut out = std::io::stdout().lock();
    if let Err(e) = out.write_all(s.as_bytes()).and_then(|_| out.flush()) {
        if e.kind() == std::io::ErrorKind::BrokenPipe {
            std::process::exit(EXIT_OK);
        }
    }
}

macro_rules! outln {
    () => { $crate::cli::output::write_stdout("\n") };
    ($($arg:tt)*) => { $crate::cli::output::write_stdout(&format!("{}\n", format!($($arg)*))) };
}
pub(crate) use outln;

/// Progress / notes for humans: stderr, so stdout stays clean for pipes.
pub fn note(s: &str) {
    let _ = writeln!(std::io::stderr().lock(), "{s}");
}

/// The single JSON document a `--json` command prints.
pub fn emit_json<T: Serialize + ?Sized>(v: &T) {
    match serde_json::to_string_pretty(v) {
        Ok(s) => write_stdout(&format!("{s}\n")),
        Err(e) => write_stdout(&format!(
            "{{\"error\":{{\"code\":\"internal\",\"message\":{}}}}}\n",
            serde_json::Value::String(e.to_string())
        )),
    }
}

// ---------------------------------------------------------------- color

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Color {
    Plain,
    Bold,
    Dim,
    Red,
    Green,
    Yellow,
    Cyan,
}

impl Color {
    fn code(self) -> &'static str {
        match self {
            Color::Plain => "",
            Color::Bold => "1",
            Color::Dim => "2",
            Color::Red => "31",
            Color::Green => "32",
            Color::Yellow => "33",
            Color::Cyan => "36",
        }
    }
}

fn colors_allowed() -> bool {
    std::env::var_os("NO_COLOR").map_or(true, |v| v.is_empty())
        && std::env::var("TERM").map_or(true, |t| t != "dumb")
}

pub fn color_stdout() -> bool {
    static C: OnceLock<bool> = OnceLock::new();
    *C.get_or_init(|| std::io::stdout().is_terminal() && colors_allowed())
}

fn color_stderr() -> bool {
    static C: OnceLock<bool> = OnceLock::new();
    *C.get_or_init(|| std::io::stderr().is_terminal() && colors_allowed())
}

pub fn paint_if(enabled: bool, c: Color, s: &str) -> String {
    if !enabled || c == Color::Plain || s.is_empty() {
        return s.to_string();
    }
    format!("\x1b[{}m{s}\x1b[0m", c.code())
}

/// Color for stdout text.
pub fn paint(c: Color, s: &str) -> String {
    paint_if(color_stdout(), c, s)
}

/// Color for stderr text.
pub fn paint_err(c: Color, s: &str) -> String {
    paint_if(color_stderr(), c, s)
}

pub fn ok_mark() -> String {
    paint(Color::Green, "✓")
}
pub fn fail_mark() -> String {
    paint(Color::Red, "✗")
}
pub fn warn_mark() -> String {
    paint(Color::Yellow, "!")
}

// ---------------------------------------------------------------- formatting helpers

/// "just now", "45s ago", "2m ago", "3h ago", "5d ago", "3w ago", then a date.
pub fn rel_time(now_ms: i64, then_ms: i64) -> String {
    if then_ms <= 0 {
        return "-".into();
    }
    let secs = (now_ms - then_ms) / 1000;
    if secs < 0 {
        // clock skew between machines
        return if secs > -60 {
            "just now".into()
        } else {
            format!("in {}", short_duration(-secs))
        };
    }
    if secs < 10 {
        return "just now".into();
    }
    if secs >= 60 * 86400 {
        return chrono::DateTime::from_timestamp_millis(then_ms)
            .map(|d| {
                d.with_timezone(&chrono::Local)
                    .format("%Y-%m-%d")
                    .to_string()
            })
            .unwrap_or_else(|| "-".into());
    }
    format!("{} ago", short_duration(secs))
}

/// 42s, 5m, 3h, 2d, 3w
pub fn short_duration(secs: i64) -> String {
    match secs {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86400 => format!("{}h", s / 3600),
        s if s < 14 * 86400 => format!("{}d", s / 86400),
        s => format!("{}w", s / (7 * 86400)),
    }
}

/// One line, at most `max` chars (an ellipsis marks the cut).
pub fn truncate(s: &str, max: usize) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    if max == 0 {
        return String::new();
    }
    let mut out: String = flat.chars().take(max - 1).collect();
    out.push('…');
    out
}

pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else if v < 10.0 {
        format!("{v:.1} {}", UNITS[i])
    } else {
        format!("{v:.0} {}", UNITS[i])
    }
}

/// 1234567 -> "1,234,567"
pub fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

/// Terminal width of stdout (wide default when piped, so grep sees whole titles).
pub fn term_width() -> usize {
    if std::io::stdout().is_terminal() {
        // SAFETY: TIOCGWINSZ fills a winsize struct we own.
        unsafe {
            let mut ws: libc::winsize = std::mem::zeroed();
            if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
                return ws.ws_col as usize;
            }
        }
    }
    std::env::var("COLUMNS")
        .ok()
        .and_then(|c| c.parse().ok())
        .filter(|w| *w >= 20)
        .unwrap_or(if std::io::stdout().is_terminal() {
            100
        } else {
            200
        })
}

/// Aligned columns; the last column is truncated to fit `width`.
pub struct Table {
    headers: Vec<String>,
    rows: Vec<Vec<(String, Color)>>,
}

impl Table {
    pub fn new(headers: &[&str]) -> Table {
        Table {
            headers: headers.iter().map(|h| h.to_string()).collect(),
            rows: Vec::new(),
        }
    }

    pub fn row(&mut self, cells: Vec<(String, Color)>) {
        self.rows.push(cells);
    }

    pub fn render(&self, width: usize, color: bool) -> String {
        let n = self.headers.len();
        let mut widths: Vec<usize> = self.headers.iter().map(|h| h.chars().count()).collect();
        for r in &self.rows {
            for (i, (text, _)) in r.iter().enumerate().take(n) {
                widths[i] = widths[i].max(text.chars().count());
            }
        }
        let fixed: usize = widths[..n.saturating_sub(1)].iter().map(|w| w + 2).sum();
        let last_max = width.saturating_sub(fixed).max(12);
        if let Some(w) = widths.last_mut() {
            *w = (*w).min(last_max);
        }
        let mut out = String::new();
        let line = |cells: Vec<(String, Color)>, out: &mut String| {
            let mut parts = Vec::new();
            for (i, (text, c)) in cells.into_iter().enumerate().take(n) {
                let text = if i + 1 == n {
                    truncate(&text, widths[i])
                } else {
                    text
                };
                let pad = if i + 1 == n {
                    0
                } else {
                    widths[i].saturating_sub(text.chars().count())
                };
                parts.push(format!("{}{}", paint_if(color, c, &text), " ".repeat(pad)));
            }
            out.push_str(parts.join("  ").trim_end());
            out.push('\n');
        };
        line(
            self.headers
                .iter()
                .map(|h| (h.clone(), Color::Dim))
                .collect(),
            &mut out,
        );
        for r in &self.rows {
            line(r.clone(), &mut out);
        }
        out
    }

    pub fn print(&self) {
        write_stdout(&self.render(term_width(), color_stdout()));
    }
}

/// Plain cell.
pub fn c(s: impl Into<String>) -> (String, Color) {
    (s.into(), Color::Plain)
}

/// Colored cell.
pub fn cc(s: impl Into<String>, color: Color) -> (String, Color) {
    (s.into(), color)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_times() {
        let now = 1_700_000_000_000;
        assert_eq!(rel_time(now, now - 3_000), "just now");
        assert_eq!(rel_time(now, now - 45_000), "45s ago");
        assert_eq!(rel_time(now, now - 120_000), "2m ago");
        assert_eq!(rel_time(now, now - 3 * 3_600_000), "3h ago");
        assert_eq!(rel_time(now, now - 5 * 86_400_000), "5d ago");
        assert_eq!(rel_time(now, now - 21 * 86_400_000), "3w ago");
        assert_eq!(rel_time(now, now + 20_000), "just now");
        assert_eq!(rel_time(now, now + 600_000), "in 10m");
        assert_eq!(rel_time(now, 0), "-");
        assert_eq!(rel_time(now, now - 90 * 86_400_000).len(), 10); // a date
    }

    #[test]
    fn truncation() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello world", 5), "hell…");
        assert_eq!(truncate("multi\nline\t text", 40), "multi line text");
        assert_eq!(truncate("héllo wörld", 6), "héllo…");
        assert_eq!(truncate("abc", 0), "");
    }

    #[test]
    fn numbers() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1536), "1.5 KB");
        assert_eq!(human_bytes(50 * 1024 * 1024), "50 MB");
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_234_567), "1,234,567");
        assert_eq!(short_id("0123456789"), "01234567");
        assert_eq!(short_id("abc"), "abc");
    }

    #[test]
    fn paint_respects_flag() {
        assert_eq!(paint_if(false, Color::Red, "x"), "x");
        assert_eq!(paint_if(true, Color::Red, "x"), "\x1b[31mx\x1b[0m");
        assert_eq!(paint_if(true, Color::Plain, "x"), "x");
    }

    #[test]
    fn table_aligns_and_truncates_last_column() {
        let mut t = Table::new(&["A", "NAME", "TITLE"]);
        t.row(vec![
            c("x"),
            c("alpha"),
            c("a fairly long title that will be cut"),
        ]);
        t.row(vec![c("yy"), c("b"), c("short")]);
        let s = t.render(30, false);
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines[0], "A   NAME   TITLE");
        assert_eq!(lines[1], "x   alpha  a fairly long titl…");
        assert_eq!(lines[2], "yy  b      short");
        assert!(lines.iter().all(|l| l.chars().count() <= 30));
    }

    #[test]
    fn error_mapping() {
        let conflict: anyhow::Error = CtlError::new("conflict", "hub moved on").into();
        let e = CliError::from_anyhow(&conflict);
        assert_eq!((e.exit, e.code.as_str()), (EXIT_BUSY, "conflict"));
        let wrapped = anyhow::Error::from(CliError::usage("bad")).context("while parsing");
        assert_eq!(CliError::from_anyhow(&wrapped).exit, EXIT_USAGE);
        let plain = anyhow::anyhow!("boom");
        assert_eq!(CliError::from_anyhow(&plain).exit, EXIT_ERR);
        let offline: anyhow::Error = CtlError::new("offline", "no hub").into();
        assert!(CliError::from_anyhow(&offline)
            .hint
            .unwrap()
            .contains("uc doctor"));
    }
}
