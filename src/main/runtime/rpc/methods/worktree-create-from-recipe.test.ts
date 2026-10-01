import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import {
  bumpLocalWorktreeScanGeneration,
  getLocalWorktreeCatalogVersion
} from '../../../local-worktree-scan-generation'
import { WORKTREE_METHODS } from './worktree'
import {
  setRecipeWorktreeCreatorForRpc,
  type RecipeWorktreeCreator
} from './worktree-create-from-recipe'

const sourceRepo = {
  id: 'source-repo',
  path: '/src/widgets',
  displayName: 'widgets',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git' as const
}

const createEphemeralVmRecipeWorktreeMock = vi.fn<RecipeWorktreeCreator>()

function createdResult(): CreateWorktreeResult {
  const result = {
    worktree: { id: 'remote-repo::/workspace/repo', repoId: 'remote-repo' },
    startupTerminal: { spawned: true, handle: 'term-agent', surface: 'background' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the worktree repo id and startup handle.
  return result as unknown as CreateWorktreeResult
}

function stubRuntime(): OrcaRuntimeService {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    dedupeWorktreeCreate: <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
      run(),
    showRepo: vi.fn().mockResolvedValue(sourceRepo),
    createManagedWorktree: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method under test reads only the members this stub provides.
  return runtime as unknown as OrcaRuntimeService
}

async function dispatch(runtime: OrcaRuntimeService, params: unknown) {
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  const request: RpcRequest = {
    id: 'req-1',
    authToken: 'tok',
    method: 'worktree.createFromRecipe',
    params
  }
  let response: unknown
  await dispatcher.dispatchStreaming(request, (r: unknown) => {
    response = typeof r === 'string' ? JSON.parse(r) : r
  })
  return response
}

afterEach(() => {
  setRecipeWorktreeCreatorForRpc(null)
  vi.clearAllMocks()
})

describe('worktree.createFromRecipe', () => {
  it('provisions from the source repo and stamps the catalog of the repo it created in', async () => {
    setRecipeWorktreeCreatorForRpc(createEphemeralVmRecipeWorktreeMock)
    const runtime = stubRuntime()
    createEphemeralVmRecipeWorktreeMock.mockImplementation(async () => {
      bumpLocalWorktreeScanGeneration('remote-repo')
      return createdResult()
    })

    const response = await dispatch(runtime, {
      repo: 'id:source-repo',
      recipe: 'cloud-sandbox',
      name: 'sandbox-task',
      baseBranch: 'origin/main',
      noParent: true,
      startupAgent: 'codex',
      startupPrompt: '',
      cliProvenanceRequest: {}
    })

    expect(response).toMatchObject({
      ok: true,
      result: {
        worktree: { id: 'remote-repo::/workspace/repo' },
        catalogVersion: getLocalWorktreeCatalogVersion('remote-repo'),
        agentTerminalHandle: 'term-agent'
      }
    })
    const call = createEphemeralVmRecipeWorktreeMock.mock.calls[0][0]
    expect(call).toMatchObject({
      recipeId: 'cloud-sandbox',
      sourceRepo,
      runtime,
      request: {
        name: 'sandbox-task',
        baseBranch: 'origin/main',
        startupAgent: 'codex',
        cliProvenance: { kind: 'created-by-cli' }
      }
    })
    expect(call.request).not.toHaveProperty('repoSelector')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('refuses on a runtime that has no recipe host', async () => {
    const response = await dispatch(stubRuntime(), {
      repo: 'id:source-repo',
      recipe: 'cloud-sandbox',
      name: 'sandbox-task'
    })

    expect(response).toMatchObject({
      ok: false,
      error: { message: 'This Orca runtime cannot provision recipe workspaces.' }
    })
    expect(createEphemeralVmRecipeWorktreeMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a recipe id', { recipe: ' ', name: 'sandbox-task' }],
    ['a workspace name', { recipe: 'cloud-sandbox' }]
  ])('rejects a request without %s', async (_missing, fields) => {
    setRecipeWorktreeCreatorForRpc(createEphemeralVmRecipeWorktreeMock)

    const response = await dispatch(stubRuntime(), { repo: 'id:source-repo', ...fields })

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(createEphemeralVmRecipeWorktreeMock).not.toHaveBeenCalled()
  })
})
