/**
 * Windows Application Control workaround.
 *
 * Some Windows machines (Smart App Control / WDAC) block loading Rollup's
 * unsigned native binding (rollup.win32-x64-msvc.node). Rollup's official
 * fallback is @rollup/wasm-node, which exposes the exact same API but is pure
 * WebAssembly — and is not blocked.
 *
 * This script patches node_modules/rollup/dist/native.js to fall back to
 * @rollup/wasm-node whenever the native binding fails to load, and is wired
 * into the root package.json "postinstall" hook so it survives reinstalling.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// Only needed on Windows; skip on Linux (Vercel, Render, CI, etc.)
if (process.platform !== 'win32') {
  process.exit(0);
}

const require = createRequire(import.meta.url);
let nativePath;
try {
  nativePath = require.resolve('rollup/dist/native.js');
} catch {
  // Rollup not present at root or already resolved differently; safe to skip.
  console.log('[patch-rollup] rollup not found at root, skipping patch');
  process.exit(0);
}

const FALLBACK_SNIPPET = `const nativeModule = (() => {
	try {
		return requireWithFriendlyError(
			existsSync(path.join(__dirname, localName)) ? localName : \`@rollup/rollup-\${packageBase}\`
		);
	} catch (error) {
		if (error instanceof Error && error.code === 'ERR_DLOPEN_FAILED') {
			// Native binding blocked (e.g. Windows Application Control) — use the WASM build.
			return require('@rollup/wasm-node/dist/native.js');
		}
		throw error;
	}
})();`;

const ORIGINAL = /const nativeModule = requireWithFriendlyError\(\s*existsSync\(path\.join\(__dirname, localName\)\) \? localName : `@rollup\/rollup-\$\{packageBase\}`\s*\);/;

const EARLIER_PATCH = /const nativeModule = \(\(\) => \{[\s\S]*?require\('@rollup\/wasm-node'\);[\s\S]*?\}\)\(\);/;

try {
  let source = readFileSync(nativePath, 'utf8');
  if (source.includes("require('@rollup/wasm-node/dist/native.js')")) {
    console.log('[patch-rollup] already patched');
  } else if (ORIGINAL.test(source) || EARLIER_PATCH.test(source)) {
    source = source.replace(ORIGINAL, FALLBACK_SNIPPET).replace(EARLIER_PATCH, FALLBACK_SNIPPET);
    writeFileSync(nativePath, source);
    console.log('[patch-rollup] patched rollup → WASM fallback on native load failure');
  } else {
    console.warn('[patch-rollup] rollup/dist/native.js did not match expected shape — skipping');
  }

  // Sanity check: try resolving the wasm package so failures surface here.
  try {
    if (existsSync(require.resolve('@rollup/wasm-node/package.json'))) {
      console.log('[patch-rollup] @rollup/wasm-node available');
    }
  } catch {
    console.warn('[patch-rollup] @rollup/wasm-node not installed — native fallback may fail');
  }
} catch (err) {
  console.warn('[patch-rollup] non-fatal patch error:', err.message);
  process.exit(0);
}
