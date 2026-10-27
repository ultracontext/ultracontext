//! uc: Claude Code and Codex sessions on every machine. See docs/DESIGN.md.

mod cli;
mod client;
mod config;
mod drivers;
mod hash;
mod hub;
mod pathmap;
mod paths;
mod proto;
mod service;
mod transport;

fn main() {
    match cli::main() {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("uc: {e:#}");
            std::process::exit(1);
        }
    }
}
