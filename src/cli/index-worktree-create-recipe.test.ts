import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { RuntimeRpcFailureError } from './runtime/types'
import { buildWorktree, okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const RECIPE_CREATE_ARGS = [
  'worktree',
  'create',
  '--repo',
  'id:repo-1',
  '--recipe',
  'cloud-sandbox',
  '--name',
  'sandbox-task',
  '--base-branch',
  'origin/main',
  '--setup',
  'skip',
  '--no-parent',
  '--json'
]

describe('orca worktree create --recipe', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('creates through worktree.createFromRecipe with a provisioning-length timeout', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: buildWorktree('/workspace/repo', 'sandbox-task', 'abc', 'remote-repo')
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(RECIPE_CREATE_ARGS, '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'worktree.createFromRecipe',
      {
        repo: 'id:repo-1',
        recipe: 'cloud-sandbox',
        name: 'sandbox-task',
        displayName: 'sandbox-task',
        displayNameKind: 'user',
        baseBranch: 'origin/main',
        linkedIssue: undefined,
        comment: undefined,
        runHooks: false,
        activate: false,
        setupDecision: 'skip',
        parentWorktree: undefined,
        noParent: true,
        callerTerminalHandle: undefined,
        cliProvenanceRequest: {}
      },
      { timeoutMs: 30 * 60_000 }
    )
  })

  it('fails closed on a runtime without the recipe method instead of creating an ordinary worktree', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_create',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method: worktree.createFromRecipe' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(RECIPE_CREATE_ARGS, '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'This Orca app cannot create recipe workspaces yet. Update Orca and try again.'
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('rejects project target flags because the recipe provisions its own host', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--project',
        'github:acme/widgets',
        '--host',
        'local',
        '--recipe',
        'cloud-sandbox',
        '--name',
        'sandbox-task',
        '--json'
      ],
      '/tmp/elsewhere'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      '--recipe provisions its own host.'
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })
})
