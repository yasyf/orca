import { defineMethod } from '../core'
import type { createEphemeralVmRecipeWorktree } from '../../../ephemeral-vm-recipe-worktree-create'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { runRpcWorktreeCreate } from './worktree-create-run'
import { WorktreeCreateFromRecipe } from './worktree-create-schemas'

export type RecipeWorktreeCreator = (
  args: Omit<Parameters<typeof createEphemeralVmRecipeWorktree>[0], 'host'>
) => Promise<CreateWorktreeResult>

// Why a module setter: recipes need the desktop's persisted Store and approved plugin recipes,
// which the shared RPC context does not carry. A headless runtime never sets it and refuses.
let createRecipeWorktree: RecipeWorktreeCreator | null = null

export function setRecipeWorktreeCreatorForRpc(creator: RecipeWorktreeCreator | null): void {
  createRecipeWorktree = creator
}

export const WORKTREE_CREATE_FROM_RECIPE_METHOD = defineMethod({
  name: 'worktree.createFromRecipe',
  params: WorktreeCreateFromRecipe,
  handler: async (params, context) => {
    const create = createRecipeWorktree
    if (!create) {
      throw new Error('This Orca runtime cannot provision recipe workspaces.')
    }
    return runRpcWorktreeCreate(
      params,
      context,
      async ({ repoSelector: _source, ...request }, repo) => {
        const result = await create({
          recipeId: params.recipe,
          sourceRepo: repo,
          request,
          runtime: context.runtime,
          ...(context.signal ? { signal: context.signal } : {})
        })
        return { result, catalogRepoId: result.worktree.repoId }
      }
    )
  }
})
