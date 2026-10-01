import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import { getEphemeralVmRecipeResultConnection } from '../shared/ephemeral-vm-recipes'
import {
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  type EphemeralVmRecipeResultWarning
} from '../shared/ephemeral-vm-recipe-diagnostics'
import { getProvisionedRootRecipeRepoUrl } from '../shared/ephemeral-vm-recipe-repo-url'
import { updateEphemeralVmRuntimeStatus } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { addEnvironmentFromPairingCode } from '../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../shared/runtime-environments'
import {
  cleanupEphemeralVmRuntime,
  provisionEphemeralVmRuntime
} from './ephemeral-vm-runtime-service'
import { connectRuntimeOwnedSshTarget } from './ephemeral-vm-runtime-ssh'
import { resolveProvisionedRootSource } from './ephemeral-vm-provisioned-root-source'
import { getRecipeRepo, resolveRecipeForRepo } from './ipc/ephemeral-vm-recipe-context'

export type EphemeralVmWorkspaceProvisionResult =
  | {
      ok: true
      connectionType: 'orca-server'
      runtime: EphemeralVmRuntimeRecord
      environment: PublicKnownRuntimeEnvironment
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: true
      connectionType: 'ssh'
      runtime: EphemeralVmRuntimeRecord
      sshTargetId: string
      expectedRefHead?: string
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: false
      error: string
      stderr: string
      stdout: string
    }

export type EphemeralVmRecipeSource =
  | { ok: true; repo: Repo; recipe: OrcaVmRecipe }
  | { ok: false; error: string }

export function resolveEphemeralVmRecipeSource(
  store: Store,
  repoId: string,
  recipeId: string,
  pluginRecipes: readonly OrcaVmRecipe[]
): EphemeralVmRecipeSource {
  const repo = getRecipeRepo(store, repoId)
  if (!repo.ok) {
    return { ok: false, error: repo.message }
  }
  const recipe = resolveRecipeForRepo(repo.repo.path, recipeId, pluginRecipes)
  if (!recipe) {
    return { ok: false, error: `Recipe not found: ${recipeId}` }
  }
  return { ok: true, repo: repo.repo, recipe }
}

/** Runs a recipe, then connects the machine it reports: an owned SSH target or a paired Orca
 *  server. Any failure after the recipe started tears the runtime back down. */
export async function provisionEphemeralVmWorkspace(args: {
  store: Store
  userDataPath: string
  repo: Repo
  recipe: OrcaVmRecipe
  workspaceName?: string
  projectId?: string
  workspaceId?: string
  branch?: string
  ref?: string
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}): Promise<EphemeralVmWorkspaceProvisionResult> {
  const { repo, recipe, userDataPath } = args
  let recipeRepoUrl = repo.gitRemoteIdentity?.remoteUrl
  let sourceRef = args.ref
  let expectedRefHead: string | undefined
  if (recipe.checkoutMode === 'provisioned-root') {
    const source = await resolveProvisionedRootSource(args.store, repo, args.ref, args.signal)
    if (args.signal?.aborted) {
      return { ok: false, error: 'Provisioning cancelled.', stdout: '', stderr: '' }
    }
    if (!source) {
      return {
        ok: false,
        error: args.ref
          ? `Could not resolve provisioned-root start ref: ${args.ref}`
          : 'Could not resolve a default provisioned-root start ref.',
        stdout: '',
        stderr: ''
      }
    }
    sourceRef = source.ref
    expectedRefHead = source.head
    recipeRepoUrl = source.remoteUrl ?? recipeRepoUrl
  }
  const repoUrl = getProvisionedRootRecipeRepoUrl(recipe.checkoutMode, recipeRepoUrl)
  const result = await provisionEphemeralVmRuntime({
    userDataPath,
    repoPath: repo.path,
    repoId: repo.id,
    recipe,
    projectId: args.projectId,
    workspaceId: args.workspaceId,
    workspaceName: args.workspaceName,
    ...(repoUrl ? { repoUrl } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(sourceRef ? { ref: sourceRef } : {}),
    ...(expectedRefHead ? { expectedRefHead } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    onStdout: args.onStdout,
    onStderr: args.onStderr
  })
  if (!result.ok) {
    return {
      ok: false,
      error: result.start.error,
      stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
      stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
    }
  }
  const connection = getEphemeralVmRecipeResultConnection(result.start.result)
  if (connection.type === 'ssh') {
    try {
      const ssh = await connectRuntimeOwnedSshTarget({
        runtimeId: result.runtime.id,
        connection,
        ...(args.signal ? { signal: args.signal } : {})
      })
      const runtime = updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
        sshTargetId: ssh.targetId
      })
      return {
        ok: true,
        connectionType: 'ssh',
        runtime,
        sshTargetId: ssh.targetId,
        ...(expectedRefHead ? { expectedRefHead } : {}),
        stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr),
        warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
      }
    } catch (error) {
      await cleanupEphemeralVmRuntime({
        userDataPath,
        repoPath: repo.path,
        recipe,
        runtimeId: result.runtime.id
      }).catch(() => undefined)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
        stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
      }
    }
  }

  let environment: ReturnType<typeof addEnvironmentFromPairingCode>
  try {
    environment = addEnvironmentFromPairingCode(userDataPath, {
      name: buildEphemeralEnvironmentName(repo.displayName, result.runtime.id),
      pairingCode: connection.pairingCode,
      source: 'ephemeral-vm'
    })
  } catch (error) {
    await cleanupEphemeralVmRuntime({
      userDataPath,
      repoPath: repo.path,
      recipe,
      runtimeId: result.runtime.id
    }).catch(() => undefined)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
      stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
    }
  }
  const runtime = updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
    runtimeEnvironmentId: environment.id
  })
  return {
    ok: true,
    connectionType: 'orca-server',
    runtime,
    environment: redactRuntimeEnvironment(environment),
    stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr),
    warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
  }
}

function buildEphemeralEnvironmentName(repoName: string, runtimeId: string): string {
  return `${repoName} VM ${runtimeId.slice(-8)}`
}
