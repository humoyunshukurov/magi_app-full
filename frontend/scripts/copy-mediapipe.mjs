// The camera checks run MediaPipe's wasm build from the app's own files, not from a CDN.
import { cpSync, mkdirSync } from "node:fs";

const from = "node_modules/@mediapipe/tasks-vision/wasm";
const to = "public/mediapipe/wasm";
mkdirSync(to, { recursive: true });
for (const name of ["vision_wasm_internal", "vision_wasm_nosimd_internal"]) {
  for (const ext of ["js", "wasm"]) cpSync(`${from}/${name}.${ext}`, `${to}/${name}.${ext}`);
}
