import assert from "node:assert/strict";
import {
  DEFAULT_MUTAGEN_VERSION,
  mutagenAsset,
  normalizeTag,
  releaseUrl,
  ultracontextAsset,
  ultracontextTarget
} from "./install.mjs";

assert.equal(ultracontextTarget("darwin", "arm64"), "aarch64-apple-darwin");
assert.equal(ultracontextTarget("darwin", "x64"), "x86_64-apple-darwin");
assert.equal(ultracontextTarget("linux", "arm64"), "aarch64-unknown-linux-gnu");
assert.equal(ultracontextTarget("linux", "x64"), "x86_64-unknown-linux-gnu");

assert.equal(ultracontextAsset("aarch64-apple-darwin"), "ultracontext-aarch64-apple-darwin.tar.gz");
assert.equal(mutagenAsset("darwin", "arm64"), `mutagen_darwin_arm64_${DEFAULT_MUTAGEN_VERSION}.tar.gz`);
assert.equal(mutagenAsset("linux", "x64"), `mutagen_linux_amd64_${DEFAULT_MUTAGEN_VERSION}.tar.gz`);

assert.equal(normalizeTag("2.0.0-alpha.0"), "v2.0.0-alpha.0");
assert.equal(normalizeTag("v2.0.0-alpha.0"), "v2.0.0-alpha.0");
assert.equal(normalizeTag("latest"), "latest");

assert.equal(
  releaseUrl({
    repo: "ultracontext/ultracontext",
    tag: "v2.0.0-alpha.0",
    asset: "ultracontext-aarch64-apple-darwin.tar.gz"
  }),
  "https://github.com/ultracontext/ultracontext/releases/download/v2.0.0-alpha.0/ultracontext-aarch64-apple-darwin.tar.gz"
);

assert.equal(
  releaseUrl({
    tag: "latest",
    asset: "ultracontext-x86_64-unknown-linux-gnu.tar.gz",
    downloadBase: "https://example.com/releases/"
  }),
  "https://example.com/releases/ultracontext-x86_64-unknown-linux-gnu.tar.gz"
);

assert.throws(() => ultracontextTarget("freebsd", "x64"), /unsupported platform/);
assert.throws(() => mutagenAsset("linux", "ia32"), /unsupported Mutagen platform/);

console.log("npm installer tests passed");
