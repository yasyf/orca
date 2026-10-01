import type { RuntimeWorktreeCreateResult } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { hasWorkspaceProjectTarget } from '../worktree-project-target'

// Why: the recipe provisions a machine before the create starts, which can take many minutes.
const RECIPE_WORKTREE_CREATE_TIMEOUT_MS = 30 * 60_000

export function getOptionalRecipeFlag(flags: Map<string, string | boolean>): string | undefined {
  if (!flags.has('recipe')) {
    return undefined
  }
  if (hasWorkspaceProjectTarget(flags)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--recipe provisions its own host. Name the source checkout with --repo instead of project target flags.'
    )
  }
  return getRequiredStringFlag(flags, 'recipe')
}

export async function createWorktreeFromRecipe(
  client: Parameters<CommandHandler>[0]['client'],
  params: Record<string, unknown> & { recipe: string }
): Promise<RuntimeRpcSuccess<RuntimeWorktreeCreateResult>> {
  try {
    return await client.call<RuntimeWorktreeCreateResult>('worktree.createFromRecipe', params, {
      timeoutMs: RECIPE_WORKTREE_CREATE_TIMEOUT_MS
    })
  } catch (error) {
    // Why: never fall back to worktree.create, which would silently drop the recipe.
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca app cannot create recipe workspaces yet. Update Orca and try again.'
      )
    }
    throw error
  }
}
