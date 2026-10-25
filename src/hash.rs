//! BLAKE3 helpers (DESIGN §3.2).

use anyhow::Result;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Window used for log tail fingerprints.
pub const TAIL_WINDOW: u64 = 4096;

pub fn hash_bytes(data: &[u8]) -> String {
    blake3::hash(data).to_hex().to_string()
}

/// Hash a whole file (streaming).
pub fn hash_file(path: &Path) -> Result<(String, u64)> {
    let mut f = std::fs::File::open(path)?;
    let mut h = blake3::Hasher::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut n_total = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        n_total += n as u64;
    }
    Ok((h.finalize().to_hex().to_string(), n_total))
}

/// Tail fingerprint of `data` (the full content of a log): hash of the last <= TAIL_WINDOW bytes,
/// salted with the total length so equal tails at different lengths differ.
pub fn tail_fp(data: &[u8]) -> String {
    let start = data.len().saturating_sub(TAIL_WINDOW as usize);
    tail_fp_parts(&data[start..], data.len() as u64)
}

/// Tail fingerprint from the window bytes and the total length.
pub fn tail_fp_parts(window: &[u8], total_len: u64) -> String {
    let mut h = blake3::Hasher::new();
    h.update(&total_len.to_le_bytes());
    h.update(window);
    h.finalize().to_hex().to_string()
}

/// Tail fingerprint of the first `len` bytes of the file at `path`.
pub fn tail_fp_file(path: &Path, len: u64) -> Result<String> {
    let mut f = std::fs::File::open(path)?;
    let start = len.saturating_sub(TAIL_WINDOW);
    f.seek(SeekFrom::Start(start))?;
    let mut window = vec![0u8; (len - start) as usize];
    f.read_exact(&mut window)?;
    Ok(tail_fp_parts(&window, len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_fp_consistent() {
        let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f");
        std::fs::write(&p, &data).unwrap();
        assert_eq!(tail_fp(&data), tail_fp_file(&p, data.len() as u64).unwrap());
        assert_eq!(tail_fp(&data[..100]), tail_fp_file(&p, 100).unwrap());
        assert_ne!(tail_fp(&data[..100]), tail_fp(&data[..101]));
        assert_eq!(tail_fp(b""), tail_fp_parts(b"", 0));
    }
}
