import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import type { CreateWorktreeResult } from '../shared/worktree/create-types'
import type {
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../shared/project-types'
import { toSshExecutionHostId } from '../shared/execution-host'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultProjectRoot
} from '../shared/ephemeral-vm-recipes'
import { getProjectHostSetupForRepo } from '../shared/project-host-setup-lookup'
import { getPortableGitHubProjectId } from '../shared/project-host-setup-projection'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime/runtime-managed-worktree-create-types'
import {
  provisionEphemeralVmWorkspace,
  resolveEphemeralVmRecipeSource
} from './ephemeral-vm-workspace-provisioning'
import { teardownEphemeralVmRuntime } from './ephemeral-vm-runtime-teardown'
import { attachEphemeralVmRuntimeToWorkspace } from './ephemeral-vm-runtime-attachment'

const MAX_PROVISION_STDERR_CHARS = 4_000

/** What a recipe needs from the desktop host: recipes run beside the source checkout. */
export type EphemeralVmRecipeWorktreeHost = {
  store: Store
  userDataPath: string
  listPluginRecipes: () => Promise<OrcaVmRecipe[]>
}

type RecipeWorktreeRuntime = {
  setupProjectExistingFolder: (
    args: ProjectHostSetupExistingFolderArgs
  ) => Promise<ProjectHostSetupResult>
  deleteProjectHostSetup: (args: ProjectHostSetupDeleteArgs) => unknown
  createManagedWorktree: (args: RuntimeManagedWorktreeCreateArgs) => Promise<CreateWorktreeResult>
}

/** Provisions a recipe's machine for `sourceRepo`, registers the checkout it reports, and creates
 *  the workspace there. Any failure after provisioning destroys the machine again. */
export async function createEphemeralVmRecipeWorktree(args: {
  recipeId: string
  sourceRepo: Repo
  request: Omit<RuntimeManagedWorktreeCreateArgs, 'repoSelector'>
  host: EphemeralVmRecipeWorktreeHost
  runtime: RecipeWorktreeRuntime
  signal?: AbortSignal
}): Promise<CreateWorktreeResult> {
  const { host, runtime, request } = args
  const source = resolveEphemeralVmRecipeSource(
    host.store,
    args.sourceRepo.id,
    args.recipeId,
    await host.listPluginRecipes()
  )
  if (!source.ok) {
    throw new Error(source.error)
  }
  const recipeOwnsCheckout = source.recipe.checkoutMode === 'provisioned-root'
  if (recipeOwnsCheckout && request.sparseCheckout) {
    throw new Error('Provisioned-root recipes do not support sparse checkout.')
  }
  const projectId =
    getPortableGitHubProjectId(source.repo) ??
    getProjectHostSetupForRepo(host.store.getProjectHostSetups?.() ?? [], source.repo).projectId
  const provisioned = await provisionEphemeralVmWorkspace({
    store: host.store,
    userDataPath: host.userDataPath,
    repo: source.repo,
    recipe: source.recipe,
    projectId,
    workspaceName: request.name,
    ...(recipeOwnsCheckout
      ? {
          branch: request.branchNameOverride ?? request.name,
          ...(request.baseBranch ? { ref: request.baseBranch } : {})
        }
      : {}),
    ...(args.signal ? { signal: args.signal } : {})
  })
  if (!provisioned.ok) {
    const stderr = provisioned.stderr.trim().slice(-MAX_PROVISION_STDERR_CHARS)
    throw new Error(stderr ? `${provisioned.error}\n${stderr}` : provisioned.error)
  }
  const runtimeId = provisioned.runtime.id
  const teardown = async (setupId?: string): Promise<void> => {
    try {
      if (setupId) {
        runtime.deleteProjectHostSetup({ setupId })
      }
      await teardownEphemeralVmRuntime(host.store, host.userDataPath, runtimeId)
    } catch (error) {
      console.error('Failed to clean up recipe runtime after workspace creation failed:', error)
    }
  }
  if (provisioned.connectionType !== 'ssh') {
    await teardown()
    throw new Error(
      'Only recipes that connect over SSH can create workspaces from the CLI. Create this workspace from the Orca app.'
    )
  }

  const projectRoot = getEphemeralVmRecipeResultProjectRoot(provisioned.runtime.recipeResult)
  const checkoutMode = getEphemeralVmRecipeResultCheckoutMode(provisioned.runtime.recipeResult)
  let setup: ProjectHostSetupResult
  try {
    setup = await runtime.setupProjectExistingFolder({
      projectId,
      hostId: toSshExecutionHostId(provisioned.sshTargetId),
      path: projectRoot,
      setupMethod: 'imported-existing-folder'
    })
  } catch (error) {
    await teardown()
    throw error
  }
  // Why: the provisioned-root project setup exists only for this VM, so it goes with it.
  const ownedSetupId = checkoutMode === 'provisioned-root' ? setup.setup.id : undefined
  if (args.signal?.aborted) {
    await teardown(ownedSetupId)
    throw new Error('Provisioning cancelled.')
  }

  let result: CreateWorktreeResult
  try {
    result = await runtime.createManagedWorktree({
      ...request,
      repoSelector: `id:${setup.repo.id}`,
      ...(checkoutMode === 'provisioned-root'
        ? {
            provisionedRoot: {
              runtimeId,
              expectedPath: projectRoot,
              ...(provisioned.expectedRefHead
                ? { expectedRefHead: provisioned.expectedRefHead }
                : {})
            }
          }
        : {})
    })
  } catch (error) {
    await teardown(ownedSetupId)
    throw error
  }
  if (checkoutMode === 'provisioned-root') {
    return result
  }
  try {
    attachEphemeralVmRuntimeToWorkspace({
      userDataPath: host.userDataPath,
      runtimeId,
      workspaceId: result.worktree.id
    })
  } catch (error) {
    const message = `Removing this workspace will not destroy its recipe machine (${runtimeId}): ${error instanceof Error ? error.message : String(error)}`
    return { ...result, warning: result.warning ? `${result.warning} ${message}` : message }
  }
  return result
}
