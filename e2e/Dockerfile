# uc e2e image: builds uc from this repo; the runtime has git + ssh for the cross-OS harness.
# Build context is the repo root:  docker build -f e2e/Dockerfile .
# (e2e/Dockerfile.dockerignore keeps target/ and .git out of the context.)
# Builder and runtime must share a Debian release (glibc).
ARG RUST_IMAGE=rust:1.96-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim

FROM ${RUST_IMAGE} AS build
WORKDIR /src
ENV CARGO_TERM_COLOR=never
# Dependency layer: rebuilt only when Cargo.toml / Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && cargo fetch --locked \
 && cargo build --release --locked \
 && rm -rf src target/release/uc target/release/deps/uc-* target/release/.fingerprint/ultracontext-*
COPY src ./src
# skills/uc/SKILL.md is embedded into the binary (include_str!)
COPY skills ./skills
# touch: COPY keeps host mtimes, which may predate the dummy build above.
RUN touch src/main.rs \
 && cargo build --release --locked \
 && install -m 0755 target/release/uc /usr/local/bin/uc

FROM ${RUNTIME_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-server openssh-client procps ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd
COPY --from=build /usr/local/bin/uc /usr/local/bin/uc
COPY e2e/entrypoint.sh /usr/local/bin/uc-e2e
RUN chmod 0755 /usr/local/bin/uc-e2e && uc --version
ENTRYPOINT ["/usr/local/bin/uc-e2e"]
CMD ["client", "root"]
