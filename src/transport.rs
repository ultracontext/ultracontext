//! Byte-stream transports to the hub (DESIGN §1). Owner: hub agent.

use anyhow::{bail, Context, Result};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::net::{TcpStream, UnixStream};

use crate::paths::{self, Paths};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Remote side of the ssh transport when `remote_uc` is not configured. Non-interactive ssh
/// shells often lack ~/.cargo/bin or ~/.local/bin in PATH, so try the usual install locations.
/// Kept free of single quotes and backslashes: it is wrapped in '...' and must survive any
/// login shell (sh, bash, zsh, fish).
const PROBE: &str = "for c in uc \"$HOME/.cargo/bin/uc\" \"$HOME/.local/bin/uc\" /usr/local/bin/uc /opt/homebrew/bin/uc; do command -v \"$c\" >/dev/null 2>&1 && exec \"$c\" hub connect; done; echo \"uc: not found on the hub host (install it there, or set remote_uc in config.toml)\" >&2; exit 127";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubAddr {
    /// `uc`, `user@host`, `ssh://user@host[:port]`
    Ssh { target: String, port: Option<u16> },
    /// `unix:/path/hub.sock`
    Unix(PathBuf),
    /// `tcp://host:port`
    Tcp(String),
    /// `local` = unix:$UC_HOME/hub.sock, auto-start a hub here
    Local,
}

impl HubAddr {
    pub fn parse(s: &str) -> Result<HubAddr> {
        let s = s.trim();
        if s.is_empty() {
            bail!("empty hub address");
        }
        if s == "local" {
            return Ok(HubAddr::Local);
        }
        if let Some(p) = s.strip_prefix("unix:") {
            if p.is_empty() {
                bail!("unix: needs a socket path, e.g. unix:/tmp/uc/hub.sock");
            }
            return Ok(HubAddr::Unix(paths::expand_tilde(p)));
        }
        if let Some(a) = s.strip_prefix("tcp://") {
            let a = a.trim_end_matches('/');
            let ok = a
                .rsplit_once(':')
                .is_some_and(|(h, p)| !h.is_empty() && p.parse::<u16>().is_ok());
            if !ok {
                bail!("bad tcp hub address {s:?}: expected tcp://host:port");
            }
            return Ok(HubAddr::Tcp(a.to_string()));
        }
        if let Some(rest) = s.strip_prefix("ssh://") {
            let rest = rest.trim_end_matches('/');
            let (target, port) = match rest.rsplit_once(':') {
                Some((t, p))
                    if !p.is_empty()
                        && p.bytes().all(|b| b.is_ascii_digit())
                        && (!t.contains(':') || t.ends_with(']')) =>
                {
                    let port = p
                        .parse::<u16>()
                        .with_context(|| format!("bad port in hub address {s:?}"))?;
                    (t, Some(port))
                }
                _ => (rest, None),
            };
            let target = target.replace(['[', ']'], "");
            check_ssh_target(&target, s)?;
            return Ok(HubAddr::Ssh { target, port });
        }
        if s.contains("://") {
            bail!("unsupported hub address {s:?} (use ssh://, tcp://, unix:/path, local, or an ssh host)");
        }
        check_ssh_target(s, s)?;
        Ok(HubAddr::Ssh {
            target: s.to_string(),
            port: None,
        })
    }
}

fn check_ssh_target(t: &str, orig: &str) -> Result<()> {
    let bad = t.is_empty()
        || t.starts_with('-')
        || t.starts_with('@')
        || t.ends_with('@')
        || t.ends_with(':')
        || t.chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '/');
    if bad {
        bail!("bad hub address {orig:?}: expected an ssh host (host, user@host, ssh://user@host:port), tcp://host:port, unix:/path or local");
    }
    Ok(())
}

impl std::fmt::Display for HubAddr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HubAddr::Ssh {
                target,
                port: Some(p),
            } => write!(f, "ssh://{target}:{p}"),
            HubAddr::Ssh { target, port: None } => write!(f, "{target}"),
            HubAddr::Unix(p) => write!(f, "unix:{}", p.display()),
            HubAddr::Tcp(a) => write!(f, "tcp://{a}"),
            HubAddr::Local => write!(f, "local"),
        }
    }
}

/// An open, not-yet-handshaken byte stream to a hub. Both directions still need the magic.
pub struct Conn {
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    /// ssh child process (killed on drop)
    pub child: Option<tokio::process::Child>,
}

/// Open a stream to the hub.
/// - Ssh: spawn `ssh -T -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3
///   [-p port] target -- <remote_uc or probe> hub connect` (probe tries `uc`, then
///   `~/.cargo/bin/uc`, `~/.local/bin/uc`, `/usr/local/bin/uc` via a tiny `sh -c` snippet).
/// - Unix / Local: connect to the socket; Local auto-starts `uc hub serve --detach` (same UC_HOME)
///   and waits up to 5s.
/// - Tcp: plain TCP (token is sent in Hello by the caller).
pub async fn connect(addr: &HubAddr, remote_uc: Option<&str>, uc_home: &Path) -> Result<Conn> {
    match addr {
        HubAddr::Unix(p) => connect_unix(p).await,
        HubAddr::Local => {
            let sock = Paths::new(uc_home.to_path_buf()).hub_sock();
            if let Ok(s) = UnixStream::connect(&sock).await {
                return Ok(unix_conn(s));
            }
            tracing::info!("no hub running on {}; starting one", sock.display());
            let home = uc_home.to_path_buf();
            tokio::task::spawn_blocking(move || crate::hub::spawn_detached(&home))
                .await
                .context("hub start task failed")??;
            connect_unix(&sock).await
        }
        HubAddr::Tcp(a) => {
            let s = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(a.as_str()))
                .await
                .with_context(|| format!("connecting to hub at tcp://{a}: timed out"))?
                .with_context(|| format!("connecting to hub at tcp://{a}"))?;
            s.set_nodelay(true)?;
            let (r, w) = s.into_split();
            Ok(Conn {
                reader: Box::new(r),
                writer: Box::new(w),
                child: None,
            })
        }
        HubAddr::Ssh { target, port } => connect_ssh(&ssh_command(), target, *port, remote_uc),
    }
}

async fn connect_unix(p: &Path) -> Result<Conn> {
    let s = UnixStream::connect(p)
        .await
        .with_context(|| format!("connecting to hub socket {}", p.display()))?;
    Ok(unix_conn(s))
}

fn unix_conn(s: UnixStream) -> Conn {
    let (r, w) = s.into_split();
    Conn {
        reader: Box::new(r),
        writer: Box::new(w),
        child: None,
    }
}

/// `UC_SSH` split on whitespace (e.g. "ssh -F /tmp/cfg -i key"), default `ssh`.
fn ssh_command() -> Vec<String> {
    let v: Vec<String> = std::env::var("UC_SSH")
        .unwrap_or_default()
        .split_whitespace()
        .map(String::from)
        .collect();
    if v.is_empty() {
        vec!["ssh".to_string()]
    } else {
        v
    }
}

/// Arguments after the ssh program: options, target, `--`, and the remote command. ssh joins
/// the remote command words with spaces and hands them to the login shell, so the command is
/// passed as one pre-quoted word.
pub fn ssh_args(target: &str, port: Option<u16>, remote_uc: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ConnectTimeout=10",
        // never ride (or kill) the user's multiplexed connection: the sync channel is long-lived
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(p) = port {
        a.push("-p".into());
        a.push(p.to_string());
    }
    a.push(target.to_string());
    a.push("--".into());
    a.push(match remote_uc.map(str::trim).filter(|s| !s.is_empty()) {
        Some(uc) => format!("{uc} hub connect"),
        None => format!("sh -c '{PROBE}'"),
    });
    a
}

fn connect_ssh(
    command: &[String],
    target: &str,
    port: Option<u16>,
    remote_uc: Option<&str>,
) -> Result<Conn> {
    let (prog, pre) = command.split_first().context("empty UC_SSH")?;
    let mut cmd = tokio::process::Command::new(prog);
    cmd.args(pre)
        .args(ssh_args(target, port, remote_uc))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .with_context(|| format!("starting `{prog}` (set UC_SSH to use another ssh)"))?;
    let stdin = child.stdin.take().context("ssh stdin")?;
    let stdout = child.stdout.take().context("ssh stdout")?;
    if let Some(stderr) = child.stderr.take() {
        let host = target.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim_end();
                if !line.is_empty() {
                    tracing::warn!(target: "uc::ssh", host = %host, "{line}");
                }
            }
        });
    }
    Ok(Conn {
        reader: Box::new(stdout),
        writer: Box::new(stdin),
        child: Some(child),
    })
}

/// `uc hub connect`: bridge stdin/stdout to `$UC_HOME/hub.sock`, starting the hub if needed.
pub async fn bridge_stdio(uc_home: &Path) -> Result<()> {
    let sock_path = Paths::new(uc_home.to_path_buf()).hub_sock();
    let sock = match std::os::unix::net::UnixStream::connect(&sock_path) {
        Ok(s) => s,
        Err(_) => {
            let home = uc_home.to_path_buf();
            tokio::task::spawn_blocking(move || crate::hub::spawn_detached(&home))
                .await
                .context("hub start task failed")??;
            std::os::unix::net::UnixStream::connect(&sock_path)
                .with_context(|| format!("connecting to {}", sock_path.display()))?
        }
    };
    // Plain threads, not tokio's stdin: a blocking stdin read cannot be cancelled and would keep
    // the runtime from shutting down after the hub side closes.
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = done_tx.send(bridge(io::stdin(), io::stdout(), sock));
    });
    done_rx.await.context("bridge thread died")??;
    Ok(())
}

/// Copy `input` -> `sock` and `sock` -> `output` (flushing every chunk) until the socket side
/// closes. When `input` ends first, the socket's write half is shut down so the peer sees EOF,
/// and whatever it still sends is delivered before returning.
pub fn bridge<R, W>(input: R, mut output: W, sock: std::os::unix::net::UnixStream) -> Result<()>
where
    R: Read + Send + 'static,
    W: Write,
{
    let mut up = sock.try_clone().context("cloning hub socket")?;
    std::thread::spawn(move || {
        let mut input = input;
        if let Err(e) = copy_flush(&mut input, &mut up) {
            tracing::debug!("bridge stdin -> hub: {e}");
        }
        let _ = up.shutdown(Shutdown::Write);
    });
    let mut down = sock;
    copy_flush(&mut down, &mut output).context("bridge hub -> stdout")?;
    Ok(())
}

fn copy_flush<R: Read, W: Write>(r: &mut R, w: &mut W) -> io::Result<u64> {
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) => return Ok(total),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        w.write_all(&buf[..n])?;
        w.flush()?;
        total += n as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::{self, Msg};
    use std::os::unix::fs::PermissionsExt;

    fn ssh(target: &str, port: Option<u16>) -> HubAddr {
        HubAddr::Ssh {
            target: target.into(),
            port,
        }
    }

    #[test]
    fn parse_forms() {
        assert_eq!(HubAddr::parse("local").unwrap(), HubAddr::Local);
        assert_eq!(
            HubAddr::parse("unix:/tmp/x/hub.sock").unwrap(),
            HubAddr::Unix("/tmp/x/hub.sock".into())
        );
        assert_eq!(
            HubAddr::parse("tcp://10.0.0.2:7707").unwrap(),
            HubAddr::Tcp("10.0.0.2:7707".into())
        );
        assert_eq!(HubAddr::parse("uc").unwrap(), ssh("uc", None));
        assert_eq!(HubAddr::parse(" fabio@uc ").unwrap(), ssh("fabio@uc", None));
        assert_eq!(
            HubAddr::parse("fabio@1.2.3.4").unwrap(),
            ssh("fabio@1.2.3.4", None)
        );
        assert_eq!(
            HubAddr::parse("ssh://fabio@host:2222").unwrap(),
            ssh("fabio@host", Some(2222))
        );
        assert_eq!(HubAddr::parse("ssh://host").unwrap(), ssh("host", None));
        assert_eq!(
            HubAddr::parse("ssh://[::1]:22").unwrap(),
            ssh("::1", Some(22))
        );
        for bad in [
            "",
            "   ",
            "unix:",
            "tcp://host",
            "tcp://:80",
            "tcp://h:99999",
            "ssh://",
            "-oProxyCommand=x",
            "a b",
            "/tmp/hub.sock",
            "http://x",
            "ssh://h:70000",
            "user@",
            "ssh://u@h:",
        ] {
            assert!(HubAddr::parse(bad).is_err(), "{bad:?} should not parse");
        }
        for s in ["local", "unix:/a/b", "tcp://h:1", "uc", "ssh://u@h:22"] {
            assert_eq!(HubAddr::parse(s).unwrap().to_string(), s);
        }
    }

    #[test]
    fn ssh_argv() {
        let a = ssh_args("fabio@uc", Some(2222), Some("/opt/uc/bin/uc"));
        assert_eq!(
            a.join(" "),
            "-T -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
             -o ConnectTimeout=10 -o ControlMaster=no -o ControlPath=none -p 2222 fabio@uc -- /opt/uc/bin/uc hub connect"
        );
        let a = ssh_args("uc", None, None);
        assert_eq!(
            a[a.len() - 3..a.len() - 1],
            ["uc".to_string(), "--".to_string()]
        );
        let remote = a.last().unwrap();
        assert!(remote.starts_with("sh -c '") && remote.ends_with('\''));
        let inner = &remote[7..remote.len() - 1];
        assert!(!inner.contains('\'') && !inner.contains('\\'));
    }

    #[test]
    fn probe_finds_uc_in_cargo_bin() {
        // A system-wide uc would be found (and run) before our fake one.
        let system = [
            "/bin/uc",
            "/usr/bin/uc",
            "/usr/local/bin/uc",
            "/opt/homebrew/bin/uc",
        ];
        if system.iter().any(|p| Path::new(p).exists()) {
            eprintln!("skipping: a system-wide uc is installed");
            return;
        }
        // the remote command as a login shell runs it, with a PATH lacking ~/.cargo/bin
        let d = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let bin = d.path().join(".cargo/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let uc = bin.join("uc");
        std::fs::write(&uc, "#!/bin/sh\necho \"fake uc $*\"\n").unwrap();
        std::fs::set_permissions(&uc, std::fs::Permissions::from_mode(0o755)).unwrap();
        let remote = ssh_args("h", None, None).pop().unwrap();
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&remote)
            .env_clear()
            .env("HOME", d.path())
            .env("PATH", "/bin:/usr/bin")
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "fake uc hub connect\n"
        );

        let empty = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&remote)
            .env_clear()
            .env("HOME", empty.path())
            .env("PATH", "/bin:/usr/bin")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(127));
        assert!(String::from_utf8_lossy(&out.stderr).contains("not found on the hub host"));
    }

    #[tokio::test]
    async fn ssh_transport_pipes_through_child() {
        // A fake ssh: prints shell noise, then the magic, then echoes stdin back.
        let d = tempfile::Builder::new()
            .prefix("uc")
            .tempdir_in("/tmp")
            .unwrap();
        let fake = d.path().join("fake-ssh");
        std::fs::write(
            &fake,
            "#!/bin/sh\necho 'motd noise'\necho 'warning from ssh' >&2\nprintf UCPROTO1\nexec cat\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cmd = vec![
            fake.to_string_lossy().to_string(),
            "-F".into(),
            "/dev/null".into(),
        ];
        let mut conn = connect_ssh(&cmd, "fabio@uc", Some(22), None).unwrap();
        assert!(conn.child.is_some());
        proto::read_magic(&mut conn.reader).await.unwrap();
        proto::write_frame(&mut conn.writer, &Msg::Ping { id: 9 }, b"bin")
            .await
            .unwrap();
        let f = proto::read_frame(&mut conn.reader).await.unwrap().unwrap();
        assert_eq!((f.msg.id(), f.bin.as_slice()), (Some(9), &b"bin"[..]));
    }

    #[test]
    fn bridge_copies_both_ways_and_drains() {
        let (ours, theirs) = std::os::unix::net::UnixStream::pair().unwrap();
        // the "hub": read everything until EOF, then answer and close
        let hub = std::thread::spawn(move || {
            let mut theirs = theirs;
            let mut got = Vec::new();
            theirs.read_to_end(&mut got).unwrap();
            theirs.write_all(b"reply:").unwrap();
            theirs.write_all(&got).unwrap();
        });
        let mut out = Vec::new();
        bridge(io::Cursor::new(b"hello hub".to_vec()), &mut out, ours).unwrap();
        hub.join().unwrap();
        assert_eq!(out, b"reply:hello hub");
    }
}
