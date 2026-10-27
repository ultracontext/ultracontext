//! Read-only smoke test of the drivers against this machine's real agent data.
//! `cargo test real_agent_data -- --ignored --nocapture` (prints counts only, never content).

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use super::{claude::Claude, codex::Codex, AgentDriver, AgentFileKind};
use crate::pathmap::PathMap;

const WINDOW: u64 = 64 * 1024;

fn windows(p: &Path) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut f = std::fs::File::open(p).ok()?;
    let len = f.metadata().ok()?.len();
    let mut head = vec![0u8; len.min(WINDOW) as usize];
    f.read_exact(&mut head).ok()?;
    let start = len.saturating_sub(WINDOW);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::new();
    f.read_to_end(&mut tail).ok()?;
    Some((head, tail))
}

fn walk(root: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    for e in rd.flatten() {
        let Ok(t) = e.file_type() else { continue };
        if t.is_dir() {
            walk(&e.path(), out);
        } else if t.is_file() {
            out.push(e.path());
        }
    }
}

fn survey(d: &dyn AgentDriver, map: &PathMap) {
    let root = d.root();
    let mut files = Vec::new();
    walk(&root, &mut files);
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
    let (mut transcripts, mut meta_ok, mut cwd_ok, mut prompt_ok, mut title_ok, mut slug_ok) =
        (0, 0, 0, 0, 0, 0);
    let mut secrets = 0;
    for p in &files {
        let rel = crate::paths::rel_canonical(&root, p).unwrap_or_default();
        let name = rel.rsplit('/').next().unwrap_or("");
        let Some(af) = d.classify(&rel) else {
            *kinds.entry("ignored").or_default() += 1;
            continue;
        };
        if name.contains("credentials") || name == "auth.json" || name.ends_with(".key") {
            secrets += 1;
        }
        *kinds
            .entry(match af.kind {
                AgentFileKind::Log => "log",
                AgentFileKind::File => "file",
            })
            .or_default() += 1;
        if !af.transcript {
            continue;
        }
        transcripts += 1;
        let Some((head, tail)) = windows(p) else {
            continue;
        };
        let Some(m) = d.parse_meta(&af.session_id, &head, &tail, map) else {
            continue;
        };
        meta_ok += 1;
        cwd_ok += m.cwd.is_some() as usize;
        prompt_ok += m.first_prompt.is_some() as usize;
        title_ok += m.title.is_some() as usize;
        // the driver must map the transcript back to where it already is
        if let Some(nr) = d.native_rel(&af.canonical, Some(&m), map) {
            slug_ok += (nr == rel) as usize;
            if nr != rel && std::env::var_os("UC_SURVEY_SHOW").is_some() {
                let cwd = m.cwd.as_deref().map(|c| map.smudge(c)).unwrap_or_default();
                println!("  mismatch: at {rel}\n            want {nr}\n            cwd exists={} relocated={}",
                    std::path::Path::new(&cwd).exists(),
                    String::from_utf8_lossy(&tail).contains("\"relocated\""));
            }
        }
    }
    println!(
        "{}: {} files, {:?}; transcripts {} (meta {}, cwd {}, first_prompt {}, title {}, native path round-trips {}); secrets classified as synced: {}",
        d.name(),
        files.len(),
        kinds,
        transcripts,
        meta_ok,
        cwd_ok,
        prompt_ok,
        title_ok,
        slug_ok,
        secrets
    );
    assert_eq!(secrets, 0, "a secret file was classified for sync");
}

#[test]
#[ignore]
fn real_agent_data() {
    let home = crate::paths::home();
    let map = PathMap::new(&home);
    survey(&Claude::from_env(), &map);
    survey(&Codex::from_env(), &map);
}
