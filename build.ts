import { readdir, readFile, writeFile, cp } from 'fs/promises'
import { join } from 'path'
import { getMacroDefines } from './scripts/defines.ts'
import { DEFAULT_BUILD_FEATURES } from './scripts/defines.ts'
import { ensureRipgrep } from './scripts/download-rg.ts'

const outdir = 'dist'

// Step 1: Clean output directory
const { rmSync, readFileSync } = await import('fs')
rmSync(outdir, { recursive: true, force: true })

// Step 1.5: Ensure ripgrep binary is downloaded
console.log('[build] Ensuring ripgrep binary...')
await ensureRipgrep()

// Read the ripgrep binary and inline as base64 via define.
// When `bun build --compile` produces a standalone exe, the define value
// is baked into the JS code as a literal string. At runtime, ripgrep.ts
// detects process.env.__RG_EMBEDDED_BASE64, decodes it, and extracts the
// binary to a temp cache directory.
//
// This approach works reliably with the two-step build process
// (Bun.build() → bun build --compile) because defines are plain string
// substitutions that survive both bundling passes.
const rgArchDir = `${process.arch}-${process.platform}`
const rgBinaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'
const rgSourcePath = `src/utils/vendor/ripgrep/${rgArchDir}/${rgBinaryName}`

let rgBase64 = ''
try {
  rgBase64 = readFileSync(rgSourcePath).toString('base64')
  const kb = Math.round((rgBase64.length * 3) / 4 / 1024)
  console.log(
    `[build] Embedded ripgrep (${rgArchDir}/${rgBinaryName}, ${kb} KB raw)`,
  )
} catch {
  console.warn(
    `[build] Warning: ${rgSourcePath} not found, ripgrep won't be embedded`,
  )
}

// Collect FEATURE_* env vars → Bun.build features
const envFeatures = Object.keys(process.env)
  .filter(k => k.startsWith('FEATURE_'))
  .map(k => k.replace('FEATURE_', ''))
const features = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]

// Step 2: Bundle with splitting
const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir,
  target: 'bun',
  splitting: true,
  sourcemap: 'linked',
  define: {
    ...getMacroDefines(),
    'process.env.NODE_ENV': JSON.stringify('production'),
    // Inline the ripgrep binary so it ends up inside the compiled exe.
    // The string is the minimum overhead approach: base64 → ~37% larger
    // than the binary, but guarantees the data survives into the compiled binary.
    'process.env.__RG_EMBEDDED_BASE64': JSON.stringify(rgBase64),
  },
  features,
})

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

// Step 3: Post-process — replace Bun-only `import.meta.require` with Node.js compatible version
const files = await readdir(outdir)
const IMPORT_META_REQUIRE = 'var __require = import.meta.require;'
const COMPAT_REQUIRE = `var __require = typeof import.meta.require === "function" ? import.meta.require : (await import("module")).createRequire(import.meta.url);`

let patched = 0
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  if (content.includes(IMPORT_META_REQUIRE)) {
    await writeFile(
      filePath,
      content.replace(IMPORT_META_REQUIRE, COMPAT_REQUIRE),
    )
    patched++
  }
}

// Also patch unguarded globalThis.Bun destructuring from third-party deps
// (e.g. @anthropic-ai/sandbox-runtime) so Node.js doesn't crash at import time.
let bunPatched = 0
const BUN_DESTRUCTURE = /var \{([^}]+)\} = globalThis\.Bun;?/g
const BUN_DESTRUCTURE_SAFE =
  'var {$1} = typeof globalThis.Bun !== "undefined" ? globalThis.Bun : {};'
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  if (BUN_DESTRUCTURE.test(content)) {
    await writeFile(
      filePath,
      content.replace(BUN_DESTRUCTURE, BUN_DESTRUCTURE_SAFE),
    )
    bunPatched++
  }
}
BUN_DESTRUCTURE.lastIndex = 0

console.log(
  `Bundled ${result.outputs.length} files to ${outdir}/ (patched ${patched} for import.meta.require, ${bunPatched} for Bun destructure)`,
)

// Step 4: Copy native .node addon files (audio-capture) and vendored binaries (ripgrep)
const audioCaptureDir = join(outdir, 'vendor', 'audio-capture')
await cp('vendor/audio-capture', audioCaptureDir, { recursive: true })
console.log(`Copied vendor/audio-capture/ → ${audioCaptureDir}/`)

const ripgrepDir = join(outdir, 'vendor', 'ripgrep')
await cp('src/utils/vendor/ripgrep', ripgrepDir, { recursive: true })
console.log(`Copied src/utils/vendor/ripgrep/ → ${ripgrepDir}/`)

// Step 5: Generate cli-bun and cli-node executable entry points
const cliBun = join(outdir, 'cli-bun.js')
const cliNode = join(outdir, 'cli-node.js')

await writeFile(cliBun, '#!/usr/bin/env bun\nimport "./cli.js"\n')

await writeFile(cliNode, '#!/usr/bin/env node\nimport "./cli.js"\n')

// Make both executable
const { chmodSync } = await import('fs')
chmodSync(cliBun, 0o755)
chmodSync(cliNode, 0o755)

console.log(`Generated ${cliBun} (shebang: bun) and ${cliNode} (shebang: node)`)
