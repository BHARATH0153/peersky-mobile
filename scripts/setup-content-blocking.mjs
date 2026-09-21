import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const isEasBuild = process.argv.includes('--eas')

if (isEasBuild && process.env.EAS_BUILD_PLATFORM !== 'android') {
  console.log('Skipping Android content-blocking setup for this EAS platform.')
  process.exit(0)
}

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

const targets = [
  'armv7-linux-androideabi',
  'aarch64-linux-android',
  'i686-linux-android',
  'x86_64-linux-android'
]

// EAS build images ship the NDK but not Rust. Install a pinned rustup there
// and let rust-toolchain.toml pick the compiler version.
const RUSTUP_INIT_VERSION = '1.29.1'
const RUSTUP_INIT_SHA256 = {
  'x86_64-unknown-linux-gnu': 'dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71',
  'aarch64-unknown-linux-gnu': '15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433'
}

if (isEasBuild && process.platform === 'linux' && !existsSync(userRustTool('rustup'))) {
  installRustup()
  run(resolveRustTool('rustup'), ['toolchain', 'install', readToolchainChannel(), '--profile', 'minimal'])
}

run(resolveRustTool('rustup'), ['target', 'add', ...targets])
run(resolveRustTool('cargo'), ['install', 'cargo-ndk', '--version', '4.1.2', '--locked'])

function installRustup () {
  const host = process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
  const expected = RUSTUP_INIT_SHA256[host]
  const url = `https://static.rust-lang.org/rustup/archive/${RUSTUP_INIT_VERSION}/${host}/rustup-init`
  const tempDir = mkdtempSync(path.join(tmpdir(), 'rustup-init-'))
  const installer = path.join(tempDir, 'rustup-init')

  console.log(`Installing rustup ${RUSTUP_INIT_VERSION} for ${host}`)

  try {
    run('curl', ['--proto', '=https', '--tlsv1.2', '-sSf', '-o', installer, url])

    const actual = createHash('sha256').update(readFileSync(installer)).digest('hex')
    if (actual !== expected) {
      throw new Error(`rustup-init checksum mismatch: expected ${expected}, got ${actual}`)
    }

    chmodSync(installer, 0o755)
    run(installer, ['-y', '--profile', 'minimal', '--default-toolchain', 'none', '--no-modify-path'])
  } finally {
    rmSync(tempDir, { force: true, recursive: true })
  }
}

function readToolchainChannel () {
  const toolchain = readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8')
  const match = /^channel\s*=\s*"([^"]+)"/m.exec(toolchain)
  if (!match) {
    throw new Error('rust-toolchain.toml does not pin a channel.')
  }

  return match[1]
}

function userRustTool (name) {
  const executable = process.platform === 'win32' ? `${name}.exe` : name
  return path.join(homedir(), '.cargo', 'bin', executable)
}

function resolveRustTool (name) {
  const userInstall = userRustTool(name)
  return existsSync(userInstall) ? userInstall : path.basename(userInstall)
}

function run (command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit'
  })
  if (result.error?.code === 'ENOENT') {
    throw new Error(`${path.basename(command)} was not found. Install Rust from https://rustup.rs/ and try again.`)
  }
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with exit code ${result.status}.`)
  }
}
