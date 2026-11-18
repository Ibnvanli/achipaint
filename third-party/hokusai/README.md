# hokusai（第三方）

上游：https://github.com/reearth/hokusai
基线 commit：`f7e998173c0e7427b95afe0b6947e3103da60f00`
许可：MIT 或 Apache-2.0（本项目按 MIT 使用）

本目录只放许可证原文。二进制产物在 `src/wasm/`，改动补丁在 `patches/`。

## 为什么要改

上游的 `HokusaiCanvas::pixels()` 返回的是**整张画布压白底**的 RGBA8：

- A4@300dpi 一次 34MB，逐帧调用不可用
- 压过白底 = 没有 alpha，无法当作一个图层

所以加了 `drainDirty()`：增量、按 64×64 块、直通 alpha、已裁到画布内。

## 重新构建

需要 Rust 工具链、`wasm32-unknown-unknown` target，以及**版本必须匹配**的 `wasm-bindgen` CLI。

```sh
git clone https://github.com/reearth/hokusai
cd hokusai
git checkout f7e998173c0e7427b95afe0b6947e3103da60f00

git apply /path/to/achipaint/patches/hokusai-wasm-drain-dirty.patch

rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130

cargo build --target wasm32-unknown-unknown --release -p hokusai-wasm
wasm-bindgen --target web \
  --out-dir /path/to/achipaint/src/wasm \
  --out-name hokusai \
  target/wasm32-unknown-unknown/release/hokusai_wasm.wasm
```

`wasm-bindgen` CLI 的版本要和 `hokusai-wasm` 依赖的 crate 版本一致，
不一致会在生成绑定时直接报错。
