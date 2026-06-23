// Python extension modules resolve CPython symbols (_Py*) at import time, not link time.
// macOS Mach-O rejects those undefined symbols unless deferred to dynamic lookup; this lets
// `cargo build` produce the cdylib standalone (Linux ELF already allows undefined symbols).
fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    if target_os == "macos" {
        println!("cargo:rustc-cdylib-link-arg=-undefined");
        println!("cargo:rustc-cdylib-link-arg=dynamic_lookup");
    }
}
