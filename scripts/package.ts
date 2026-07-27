#!/usr/bin/env bun
/**
 * Packaging script: builds the CLI and compiles it to a standalone binary
 * with ripgrep embedded directly into the exe as a build asset.
 *
 * Usage:
 *   bun run scripts/package.ts                # default name "claude"
 *   bun run scripts/package.ts --outfile my-cli  # custom output name
 *
 * What it does:
 *   1. Run `build.ts` — produces dist/cli.js + chunk files (ripgrep embedded
 *      as a Bun.build asset, available at runtime via Bun.embeddedFiles)
 *   2. Compile dist/cli.js → standalone exe (`bun build --compile`)
 *
 * The compiled exe is fully self-contained — no external files needed.
 */

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = resolve(__dirname, '..')

// Parse args
const args = process.argv.slice(2)
const outfileIndex = args.indexOf('--outfile')
const outfile = outfileIndex !== -1 ? args[outfileIndex + 1] : 'claude'

async function main() {
  // Step 1: Build via build.ts (embeds ripgrep as Bun.build asset)
  console.log('[package] Step 1/2: Building...')
  const buildResult = spawnSync('bun', ['run', 'build.ts'], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
  })
  if (buildResult.status !== 0) {
    console.error('[package] Build failed')
    process.exit(1)
  }

  // Step 2: Compile to standalone binary
  // Bun.build assets are carried through to the compiled exe, making
  // ripgrep available at runtime via Bun.embeddedFiles — no vendor/ dir needed.
  console.log('[package] Step 2/2: Compiling standalone binary...')
  const compileArgs = [
    'build',
    '--compile',
    'dist/cli.js',
    '--outfile',
    outfile,
  ]
  const compileResult = spawnSync('bun', compileArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
  })
  if (compileResult.status !== 0) {
    console.error('[package] Compilation failed')
    process.exit(1)
  }

  const exeName = process.platform === 'win32' ? `${outfile}.exe` : outfile
  const exePath = resolve(projectRoot, exeName)
  const size = await getFileSize(exePath)
  console.log(`\n[package] ✅ Packaged: ${exePath} (${formatSize(size)})`)
  console.log(`[package] Run: ./${exeName}`)
}

async function getFileSize(filePath: string): Promise<number> {
  const { stat } = await import('node:fs/promises')
  try {
    const st = await stat(filePath)
    return st.size
  } catch {
    return 0
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

main().catch(err => {
  console.error('[package] Fatal error:', err)
  process.exit(1)
})
