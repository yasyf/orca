#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Why musl on Linux: a static binary has no glibc symbol versions for the packaged glibc floor.
const RUST_TARGETS = {
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
  linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' }
}

function posixAgentHookTarget(platform, arch) {
  const target = RUST_TARGETS[platform]?.[arch]
  if (!target) {
    throw new Error(`Unsupported agent hook target: ${platform}-${arch}`)
  }
  return target
}

function posixAgentHookOutputPath(repoRoot, platform, arch) {
  return join(
    repoRoot,
    'native',
    'windows-agent-hook',
    '.build',
    `${platform}-${arch}`,
    'orca-agent-hook'
  )
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  return result
}

// Missing output must fail: electron-builder would otherwise package the app without the hook.
function buildPosixAgentHook({ repoRoot, platform, arch }) {
  const target = posixAgentHookTarget(platform, arch)
  if (platform === 'linux' && arch !== process.arch) {
    throw new Error(
      `The Linux agent hook builds on its own architecture; this host is ${process.arch}.`
    )
  }
  const crateRoot = join(repoRoot, 'native', 'windows-agent-hook')
  const targetDirectory = join(crateRoot, 'target')
  // rustup is optional: a toolchain that already carries the target needs nothing added.
  run('rustup', ['target', 'add', target], { cwd: crateRoot })
  const result = run(
    'cargo',
    [
      'build',
      '--release',
      '--locked',
      '--manifest-path',
      join(crateRoot, 'Cargo.toml'),
      '--target-dir',
      targetDirectory,
      '--target',
      target
    ],
    { cwd: crateRoot }
  )
  if (result.error) {
    throw new Error(
      `Unable to run cargo for the agent hook: ${result.error.message}. Install Rust (https://rustup.rs) and retry.`
    )
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
  const outputPath = posixAgentHookOutputPath(repoRoot, platform, arch)
  mkdirSync(resolve(outputPath, '..'), { recursive: true })
  copyFileSync(join(targetDirectory, target, 'release', 'orca-agent-hook'), outputPath)
  chmodSync(outputPath, 0o755)
  return outputPath
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildPosixAgentHook({
    repoRoot: resolve(import.meta.dirname, '../../../..'),
    platform: readArg('--platform') ?? process.platform,
    arch: readArg('--arch') ?? process.arch
  })
}
