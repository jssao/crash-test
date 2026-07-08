/*
 * No-op translation unit. Its only purpose is to give the emcc "executable" target a source file
 * to link, so the linker pulls in and exports the box3d core library's symbols (per
 * scripts/exports.json) into a single wasm module. Linked with --no-entry, so no main() is needed
 * or called.
 */
