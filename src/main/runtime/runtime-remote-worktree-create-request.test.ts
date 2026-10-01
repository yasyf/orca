import { afterEach, describe, expect, it, vi } from 'vitest'

const { adoptProvisionedRootSshCheckoutMock, createRemoteWorktreeMock } = vi.hoisted(() => ({
  adoptProvisionedRootSshCheckoutMock: vi.fn(),
  createRemoteWorktreeMock: vi.fn()
}))

vi.mock('../provisioned-root-ssh-adoption', () => ({
  adoptProvisionedRootSshCheckout: adoptProvisionedRootSshCheckoutMock
}))

vi.mock('../ipc/worktree-remote', () => ({
  createRemoteWorktree: createRemoteWorktreeMock
}))

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/user-data' })
}))

import type { Repo } from '../../shared/repo-types'
import type { RuntimeStore } from './runtime-store-contract'
import { requestRuntimeRemoteWorktree } from './runtime-remote-worktree-create-request'

const storedRepo: Repo = {
  id: 'remote-repo',
  path: '/workspace/repo',
  displayName: 'widgets',
  badgeColor: '#000',
  addedAt: 1,
  connectionId: 'runtime-ssh-target'
}

function makeStore() {
  const store = {
    getRepos: () => [storedRepo],
    setWorktreeMeta: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the request reads only these store members once the git layers are mocked.
  return store as unknown as RuntimeStore & typeof store
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('requestRuntimeRemoteWorktree', () => {
  it('adopts a recipe-provisioned checkout instead of adding a linked worktree', async () => {
    const store = makeStore()
    adoptProvisionedRootSshCheckoutMock.mockResolvedValue({
      worktree: { id: 'remote-repo::/workspace/repo' }
    })

    const result = await requestRuntimeRemoteWorktree(
      { ...storedRepo },
      {
        name: 'sandbox-task',
        baseBranch: 'origin/main',
        comment: 'from the CLI',
        cliProvenance: { kind: 'created-by-cli', createdAt: 1 },
        provisionedRoot: {
          runtimeId: 'vm-1',
          expectedPath: '/workspace/repo',
          expectedRefHead: 'abc123'
        }
      },
      store
    )

    expect(createRemoteWorktreeMock).not.toHaveBeenCalled()
    const adoption = adoptProvisionedRootSshCheckoutMock.mock.calls[0][0]
    expect(adoption).toMatchObject({
      userDataPath: '/user-data',
      repo: storedRepo,
      request: {
        repoId: 'remote-repo',
        name: 'sandbox-task',
        baseBranch: 'origin/main',
        cliProvenance: { kind: 'created-by-cli', createdAt: 1 },
        runtimeId: 'vm-1',
        expectedPath: '/workspace/repo',
        expectedRefHead: 'abc123',
        executionHostId: 'ssh:runtime-ssh-target'
      }
    })
    expect(adoption.isRepoCurrent()).toBe(true)
    expect(store.setWorktreeMeta).toHaveBeenCalledWith('remote-repo::/workspace/repo', {
      comment: 'from the CLI'
    })
    expect(result.worktree.comment).toBe('from the CLI')
  })

  it('keeps ordinary SSH creates on git worktree add', async () => {
    createRemoteWorktreeMock.mockResolvedValue({ worktree: { id: 'remote-repo::/wt' } })

    await requestRuntimeRemoteWorktree(storedRepo, { name: 'feature' }, makeStore())

    expect(adoptProvisionedRootSshCheckoutMock).not.toHaveBeenCalled()
    expect(createRemoteWorktreeMock).toHaveBeenCalledWith(
      { repoId: 'remote-repo', name: 'feature' },
      storedRepo,
      expect.anything(),
      expect.anything()
    )
  })
})
