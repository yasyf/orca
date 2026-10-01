import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../shared/pairing'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import { projectHostSetupProjectionFromRepos } from '../shared/project-host-setup-projection'
import type { Repo } from '../shared/repo-types'
import type { CreateWorktreeResult } from '../shared/worktree/create-types'
import type { Store } from './persistence'

const { connectRuntimeOwnedSshTargetMock, removeRuntimeOwnedSshTargetMock } = vi.hoisted(() => ({
  connectRuntimeOwnedSshTargetMock: vi.fn(),
  removeRuntimeOwnedSshTargetMock: vi.fn()
}))

vi.mock('./ephemeral-vm-runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: connectRuntimeOwnedSshTargetMock,
  disconnectRuntimeOwnedSshTarget: vi.fn(),
  removeRuntimeOwnedSshTarget: removeRuntimeOwnedSshTargetMock
}))

import { createEphemeralVmRecipeWorktree } from './ephemeral-vm-recipe-worktree-create'

const SSH_TARGET_ID = 'runtime-ssh-target'
const PROJECT_ROOT = '/workspace/repo'

let userDataPath: string
let repoPath: string
let sourceRepo: Repo

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-recipe-create-user-data-'))
  repoPath = mkdtempSync(join(tmpdir(), 'orca-recipe-create-repo-'))
  sourceRepo = {
    id: 'source-repo',
    path: repoPath,
    displayName: 'Widgets',
    badgeColor: '#000',
    addedAt: 0,
    upstream: { owner: 'acme', repo: 'widgets' }
  }
  connectRuntimeOwnedSshTargetMock.mockResolvedValue({
    targetId: SSH_TARGET_ID,
    target: { id: SSH_TARGET_ID }
  })
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
  rmSync(repoPath, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('createEphemeralVmRecipeWorktree', () => {
  it('creates an orca-worktree recipe workspace on the provisioned SSH host and links the runtime', async () => {
    commitFixture(repoPath)
    writeRecipe({ checkoutMode: 'orca-worktree', result: sshResult(1) })
    const runtime = makeRuntime()

    const result = await create(runtime, { name: 'sandbox-task', baseBranch: 'origin/main' })

    expect(runtime.setupProjectExistingFolder).toHaveBeenCalledWith({
      projectId: 'github:acme/widgets',
      hostId: `ssh:${SSH_TARGET_ID}`,
      path: PROJECT_ROOT,
      setupMethod: 'imported-existing-folder'
    })
    const createArgs = runtime.createManagedWorktree.mock.calls[0][0]
    expect(createArgs).toMatchObject({
      repoSelector: 'id:remote-repo',
      name: 'sandbox-task',
      baseBranch: 'origin/main'
    })
    expect(createArgs).not.toHaveProperty('provisionedRoot')
    expect(result.worktree.id).toBe('remote-repo::/workspace/repo-wt')
    expect(onlyRuntime()).toMatchObject({
      status: 'running',
      sshTargetId: SSH_TARGET_ID,
      workspaceId: 'remote-repo::/workspace/repo-wt'
    })
  })

  it('pins a provisioned-root recipe to the requested branch and source ref head', async () => {
    commitFixture(repoPath)
    const selectedHead = branchCommit(repoPath, 'selected')
    const envPath = join(repoPath, 'create-env.json')
    writeRecipe({ checkoutMode: 'provisioned-root', result: sshResult(2), envPath })
    const runtime = makeRuntime()

    await create(runtime, { name: 'sandbox-task', baseBranch: 'selected' })

    expect(JSON.parse(readFileSync(envPath, 'utf8'))).toEqual({
      branch: 'sandbox-task',
      ref: 'selected',
      refHead: selectedHead,
      projectId: 'github:acme/widgets',
      workspaceName: 'sandbox-task'
    })
    const runtimeId = onlyRuntime().id
    expect(runtime.createManagedWorktree.mock.calls[0][0]).toMatchObject({
      repoSelector: 'id:remote-repo',
      provisionedRoot: { runtimeId, expectedPath: PROJECT_ROOT, expectedRefHead: selectedHead }
    })
    expect(onlyRuntime().workspaceId).toBeUndefined()
  })

  it('removes the provisioned-root setup and destroys the machine when adoption fails', async () => {
    commitFixture(repoPath)
    const destroyPath = join(repoPath, 'destroy.txt')
    writeRecipe({ checkoutMode: 'provisioned-root', result: sshResult(2), destroyPath })
    const runtime = makeRuntime()
    runtime.createManagedWorktree.mockRejectedValue(new Error('adoption failed'))

    await expect(create(runtime, { name: 'sandbox-task' })).rejects.toThrow('adoption failed')

    expect(runtime.deleteProjectHostSetup).toHaveBeenCalledWith({ setupId: runtime.remoteSetupId })
    expect(readFileSync(destroyPath, 'utf8')).toBe('x')
    expect(removeRuntimeOwnedSshTargetMock).toHaveBeenCalledWith(SSH_TARGET_ID)
  })

  it('destroys the machine without touching project setups when registration fails', async () => {
    commitFixture(repoPath)
    const destroyPath = join(repoPath, 'destroy.txt')
    writeRecipe({ checkoutMode: 'orca-worktree', result: sshResult(1), destroyPath })
    const runtime = makeRuntime()
    runtime.setupProjectExistingFolder.mockRejectedValue(new Error('import failed'))

    await expect(create(runtime, { name: 'sandbox-task' })).rejects.toThrow('import failed')

    expect(readFileSync(destroyPath, 'utf8')).toBe('x')
    expect(runtime.deleteProjectHostSetup).not.toHaveBeenCalled()
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('refuses an Orca-server recipe instead of creating an ordinary workspace', async () => {
    commitFixture(repoPath)
    const destroyPath = join(repoPath, 'destroy.txt')
    const pairingCode = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'wss://sandbox.example.com',
      deviceToken: 'token',
      publicKeyB64: 'public-key'
    })
    writeRecipe({
      checkoutMode: 'orca-worktree',
      result: { schemaVersion: 1, pairingCode, projectRoot: PROJECT_ROOT },
      destroyPath
    })
    const runtime = makeRuntime()

    await expect(create(runtime, { name: 'sandbox-task' })).rejects.toThrow(
      'Only recipes that connect over SSH can create workspaces from the CLI.'
    )

    expect(readFileSync(destroyPath, 'utf8')).toBe('x')
    expect(runtime.setupProjectExistingFolder).not.toHaveBeenCalled()
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('surfaces recipe stderr when provisioning fails', async () => {
    commitFixture(repoPath)
    writeRecipe({ checkoutMode: 'orca-worktree', result: sshResult(1), failWith: 'quota exceeded' })
    const runtime = makeRuntime()

    await expect(create(runtime, { name: 'sandbox-task' })).rejects.toThrow('quota exceeded')

    expect(runtime.setupProjectExistingFolder).not.toHaveBeenCalled()
  })

  it('rejects an unknown recipe before running anything', async () => {
    commitFixture(repoPath)
    writeRecipe({ checkoutMode: 'orca-worktree', result: sshResult(1) })
    const runtime = makeRuntime()

    await expect(create(runtime, { name: 'sandbox-task' }, 'missing-recipe')).rejects.toThrow(
      'Recipe not found: missing-recipe'
    )

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([])
  })

  it('rejects sparse checkout for a provisioned-root recipe before provisioning', async () => {
    commitFixture(repoPath)
    const destroyPath = join(repoPath, 'destroy.txt')
    writeRecipe({ checkoutMode: 'provisioned-root', result: sshResult(2), destroyPath })
    const runtime = makeRuntime()

    await expect(
      create(runtime, { name: 'sandbox-task', sparseCheckout: { directories: ['src'] } })
    ).rejects.toThrow('Provisioned-root recipes do not support sparse checkout.')

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([])
    expect(existsSync(destroyPath)).toBe(false)
  })
})

function create(
  runtime: ReturnType<typeof makeRuntime>,
  request: Parameters<typeof createEphemeralVmRecipeWorktree>[0]['request'],
  recipeId = 'cloud-sandbox'
) {
  return createEphemeralVmRecipeWorktree({
    recipeId,
    sourceRepo,
    request,
    host: {
      store: makeStore(),
      userDataPath,
      listPluginRecipes: async () => []
    },
    runtime
  })
}

type RecipeRuntime = Parameters<typeof createEphemeralVmRecipeWorktree>[0]['runtime']

function makeRuntime() {
  const remoteRepo: Repo = {
    ...sourceRepo,
    id: 'remote-repo',
    path: PROJECT_ROOT,
    connectionId: SSH_TARGET_ID
  }
  const projection = projectHostSetupProjectionFromRepos([remoteRepo])
  return {
    setupProjectExistingFolder: vi.fn<RecipeRuntime['setupProjectExistingFolder']>(async () => ({
      project: projection.projects[0],
      setup: projection.setups[0],
      repo: remoteRepo
    })),
    deleteProjectHostSetup: vi.fn<RecipeRuntime['deleteProjectHostSetup']>(),
    createManagedWorktree: vi.fn<RecipeRuntime['createManagedWorktree']>(async () =>
      createdWorktree()
    ),
    remoteSetupId: projection.setups[0].id
  }
}

function createdWorktree(): CreateWorktreeResult {
  const worktree = { id: 'remote-repo::/workspace/repo-wt', repoId: 'remote-repo' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the coordinator reads only the worktree id.
  return { worktree } as unknown as CreateWorktreeResult
}

function makeStore(): Store {
  const store = {
    getRepo: (id: string) => (id === sourceRepo.id ? sourceRepo : null),
    getRepos: () => [sourceRepo],
    getSettings: () => ({ activeRuntimeEnvironmentId: null }),
    getProjectHostSetups: () => []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recipe provisioning and teardown read only these Store members.
  return store as unknown as Store
}

function onlyRuntime() {
  const runtimes = listEphemeralVmRuntimes(userDataPath)
  expect(runtimes).toHaveLength(1)
  return runtimes[0]
}

function sshResult(schemaVersion: 1 | 2) {
  return {
    schemaVersion,
    ...(schemaVersion === 2 ? { checkoutMode: 'provisioned-root' } : {}),
    connection: {
      type: 'ssh',
      projectRoot: PROJECT_ROOT,
      target: { label: 'Sandbox', host: 'host', port: 22, username: 'root' }
    }
  }
}

function writeRecipe(args: {
  checkoutMode: 'orca-worktree' | 'provisioned-root'
  result: unknown
  envPath?: string
  destroyPath?: string
  failWith?: string
}): void {
  const startPath = join(repoPath, 'start.js')
  writeFileSync(
    startPath,
    [
      ...(args.envPath
        ? [
            `require('node:fs').writeFileSync(${JSON.stringify(args.envPath)}, JSON.stringify({branch:process.env.ORCA_REPO_BRANCH,ref:process.env.ORCA_REPO_REF,refHead:process.env.ORCA_REPO_REF_HEAD,projectId:process.env.ORCA_PROJECT_ID,workspaceName:process.env.ORCA_WORKSPACE_NAME}))`
          ]
        : []),
      ...(args.failWith
        ? [`console.error(${JSON.stringify(args.failWith)})`, 'process.exit(1)']
        : []),
      `console.log(${JSON.stringify(JSON.stringify(args.result))})`
    ].join('\n')
  )
  const destroy = args.destroyPath
    ? (() => {
        const destroyScript = join(repoPath, 'destroy.js')
        writeFileSync(
          destroyScript,
          `require('node:fs').appendFileSync(${JSON.stringify(args.destroyPath)}, 'x')`
        )
        return JSON.stringify(`"${process.execPath}" "${destroyScript}"`)
      })()
    : 'none'
  writeFileSync(
    join(repoPath, 'orca.yaml'),
    [
      'environmentRecipes:',
      '  - id: cloud-sandbox',
      '    name: Cloud Sandbox',
      ...(args.checkoutMode === 'provisioned-root' ? ['    checkoutMode: provisioned-root'] : []),
      `    create: ${JSON.stringify(`"${process.execPath}" "${startPath}"`)}`,
      `    destroy: ${destroy}`
    ].join('\n')
  )
}

function commitFixture(path: string): void {
  git(path, 'init')
  git(path, 'config', 'user.email', 'test@example.com')
  git(path, 'config', 'user.name', 'Test')
  git(path, 'branch', '-M', 'main')
  writeFileSync(join(path, 'fixture.txt'), 'fixture')
  git(path, 'add', 'fixture.txt')
  git(path, 'commit', '-m', 'fixture')
}

function branchCommit(path: string, branch: string): string {
  git(path, 'checkout', '-b', branch)
  writeFileSync(join(path, 'fixture.txt'), branch)
  git(path, 'add', 'fixture.txt')
  git(path, 'commit', '-m', branch)
  const head = git(path, 'rev-parse', 'HEAD')
  git(path, 'checkout', 'main')
  return head
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}
