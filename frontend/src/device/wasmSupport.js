// Can this WebView run the scan models at all?
//
// onnxruntime-web 1.31 ships only SIMD builds of its wasm, so a WebView without
// WebAssembly SIMD cannot run milo or cornelius, and every on-device scan would
// fail. That is iOS before 16.4 (Safari added SIMD there; the app supports 15.0).
// Asked before the ~70 MB of scan data is downloaded rather than after (MOB-04).

// The smallest module that uses a SIMD instruction: a function returning
// i8x16.popcnt(i8x16.splat(0)). WebAssembly.validate() compiles nothing and
// answers false where v128 is unknown.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,          // \0asm, version 1
  1, 5, 1, 96, 0, 1, 123,               // type: () -> v128
  3, 2, 1, 0,                           // one function of that type
  10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,   // i32.const 0; i8x16.splat; i8x16.popcnt; end
]);

export function wasmSimdSupported(wasm = globalThis.WebAssembly) {
  try {
    return !!wasm && typeof wasm.validate === 'function' && wasm.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

export const NO_SIMD_MESSAGE = 'This phone cannot run the scan models: its web engine has no WebAssembly SIMD, '
  + 'which they need (on an iPhone, iOS 16.4 or later).';
