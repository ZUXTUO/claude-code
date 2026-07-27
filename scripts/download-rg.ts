#!/usr/bin/env bun
/**
 * Shared utility: download ripgrep binary for the current platform
 * from BurntSushi/ripgrep releases if not already present.
 *
 * Idempotent — skips if the binary already exists.
 * Non-fatal — never throws; returns false on failure.
 *
 * Import from build scripts:
 *   import { ensureRipgrep } from './download-rg.ts'
 *   await ensureRipgrep()
 *
 * Or run standalone:
 *   bun run scripts/download-rg.ts
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// --- Config ---
const RG_VERSION = '15.2.0'
const RELEASE_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}`

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

// --- Platform mapping ---

function getPlatformSubdir(): string {
  return `${process.arch}-${process.platform}`
}

function getBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg'
}

function getVendorDir(): string {
  return path.resolve(projectRoot, 'src', 'utils', 'vendor', 'ripgrep')
}

function getBinaryPath(): string {
  return getBinaryPathIn(getVendorDir())
}

function getBinaryPathIn(vendorDir: string): string {
  return path.resolve(vendorDir, getPlatformSubdir(), getBinaryName())
}

interface PlatformMapping {
  target: string // Rust target triple for BurntSushi/ripgrep releases
  ext: string // 'tar.gz' or 'zip'
}

function getPlatformMapping(): PlatformMapping {
  const arch = process.arch
  const platform = process.platform

  if (platform === 'darwin') {
    if (arch === 'arm64')
      return { target: 'aarch64-apple-darwin', ext: 'tar.gz' }
    if (arch === 'x64') return { target: 'x86_64-apple-darwin', ext: 'tar.gz' }
    throw new Error(`Unsupported macOS arch: ${arch}`)
  }
  if (platform === 'win32') {
    if (arch === 'x64') return { target: 'x86_64-pc-windows-msvc', ext: 'zip' }
    if (arch === 'arm64')
      return { target: 'aarch64-pc-windows-msvc', ext: 'zip' }
    throw new Error(`Unsupported Windows arch: ${arch}`)
  }
  if (platform === 'linux') {
    if (arch === 'x64')
      return { target: 'x86_64-unknown-linux-musl', ext: 'tar.gz' }
    if (arch === 'arm64') {
      const isMusl = detectMusl()
      return isMusl
        ? { target: 'aarch64-unknown-linux-musl', ext: 'tar.gz' }
        : { target: 'aarch64-unknown-linux-gnu', ext: 'tar.gz' }
    }
    throw new Error(`Unsupported Linux arch: ${arch}`)
  }
  throw new Error(`Unsupported platform: ${platform}`)
}

function detectMusl(): boolean {
  const muslArch = process.arch === 'x64' ? 'x86_64' : 'aarch64'
  try {
    statSync(`/lib/libc.musl-${muslArch}.so.1`)
    return true
  } catch {
    return false
  }
}

// The binary inside the archive is at: ripgrep-{version}-{target}/rg (or rg.exe)
function getArchiveBinaryName(target: string): string {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  return `ripgrep-${RG_VERSION}-${target}/${binary}`
}

// --- Download ---

async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`,
    )
  }
  return Buffer.from(await response.arrayBuffer())
}

// --- Extraction ---

async function extractZip(
  buffer: Buffer,
  binaryPath: string,
  archiveBinaryName: string,
): Promise<void> {
  const binaryDir = path.dirname(binaryPath)

  // Try fflate first (bundled dep)
  try {
    // Dynamic import for ESM compat
    const fflate = await import('fflate')
    const unzipped = fflate.unzipSync(new Uint8Array(buffer))
    const key = Object.keys(unzipped).find(k => {
      const norm = k.replace(/\\/g, '/')
      return (
        norm === archiveBinaryName || norm.endsWith(`/${archiveBinaryName}`)
      )
    })
    if (!key) throw new Error(`Binary ${archiveBinaryName} not found in zip`)
    writeFileSync(binaryPath, Buffer.from(unzipped[key]))
    return
  } catch {
    // Fall through to system CLI extraction
  }

  // Fallback: use system unzip or PowerShell
  const tmpDir = path.join(binaryDir, '.tmp-download')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  try {
    const archivePath = path.join(tmpDir, 'archive.zip')
    writeFileSync(archivePath, buffer)

    // Try PowerShell Expand-Archive on Windows first
    if (process.platform === 'win32') {
      const psCmd = `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          psCmd,
        ],
        { stdio: 'pipe', windowsHide: true },
      )
    }

    // Try unzip CLI (works on all platforms if installed)
    spawnSync('unzip', ['-o', archivePath, '-d', tmpDir], { stdio: 'pipe' })

    const srcBinary = path.join(tmpDir, archiveBinaryName)
    if (!existsSync(srcBinary)) {
      throw new Error(`Binary not found at expected path: ${srcBinary}`)
    }
    renameSync(srcBinary, binaryPath)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

function extractTarGz(
  buffer: Buffer,
  binaryPath: string,
  archiveBinaryName: string,
  assetName: string,
): void {
  const binaryDir = path.dirname(binaryPath)
  const tmpDir = path.join(binaryDir, '.tmp-download')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  try {
    const archivePath = path.join(tmpDir, assetName)
    writeFileSync(archivePath, buffer)
    const result = spawnSync(
      'tar',
      ['xzf', archivePath, '--directory', tmpDir],
      {
        stdio: 'pipe',
      },
    )
    if (result.status !== 0) {
      throw new Error(
        `tar extract failed: ${result.stderr?.toString().trim() || `exit code ${result.status}`}`,
      )
    }
    const srcBinary = path.join(tmpDir, archiveBinaryName)
    if (!existsSync(srcBinary)) {
      throw new Error(`Binary not found at expected path: ${srcBinary}`)
    }
    renameSync(srcBinary, binaryPath)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

// --- Public API ---

/**
 * Ensure the ripgrep binary exists for the current platform.
 *
 * Downloads from BurntSushi/ripgrep GitHub releases if not present.
 * Idempotent — safe to call multiple times.
 * Non-fatal — logs errors to stderr, returns false on failure.
 */
export async function ensureRipgrep(): Promise<boolean> {
  return ensureRipgrepTo(getVendorDir())
}

/**
 * Ensure the ripgrep binary exists at a specific directory.
 *
 * Downloads from BurntSushi/ripgrep GitHub releases if not present
 * and places the binary under `vendorDir/<arch>-<platform>/rg` (or rg.exe).
 * Idempotent — safe to call multiple times.
 * Non-fatal — logs errors to stderr, returns false on failure.
 */
export async function ensureRipgrepTo(vendorDir: string): Promise<boolean> {
  const binaryPath = getBinaryPathIn(vendorDir)

  // Already exists — skip
  if (existsSync(binaryPath)) {
    const st = statSync(binaryPath)
    if (st.size > 0) {
      return true
    }
  }

  let target: string
  let ext: string
  try {
    const mapping = getPlatformMapping()
    target = mapping.target
    ext = mapping.ext
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[ripgrep] ${msg} — skip download`)
    return false
  }

  const assetName = `ripgrep-${RG_VERSION}-${target}.${ext}`
  const url = `${RELEASE_BASE}/${assetName}`
  const binaryDir = path.dirname(binaryPath)
  const archiveBinaryName = getArchiveBinaryName(target)

  console.error(`[ripgrep] Downloading v${RG_VERSION} for ${target}...`)

  try {
    const maxRetries = 2
    let buffer: Buffer | undefined
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        buffer = await downloadFile(url)
        break
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < maxRetries) {
          console.error(`[ripgrep] Attempt ${attempt} failed, retrying...`)
          // Wait 1 second before retry
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }

    if (!buffer) throw lastError ?? new Error('Download failed after retries')
    console.error(`[ripgrep] Downloaded ${Math.round(buffer.length / 1024)} KB`)

    mkdirSync(binaryDir, { recursive: true })

    if (ext === 'tar.gz') {
      extractTarGz(buffer, binaryPath, archiveBinaryName, assetName)
    } else {
      await extractZip(buffer, binaryPath, archiveBinaryName)
    }

    if (process.platform !== 'win32') {
      chmodSync(binaryPath, 0o755)
    }

    console.error(`[ripgrep] Installed to ${binaryPath}`)
    return true
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[ripgrep] Failed to download: ${msg}`)
    return false
  }
}

// --- Standalone entry ---
if (import.meta.main) {
  ensureRipgrep().then(success => {
    if (!success) process.exit(1)
  })
}
