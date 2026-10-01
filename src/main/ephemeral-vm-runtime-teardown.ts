import type { Store } from './persistence'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { removeEnvironment } from '../shared/runtime-environment-store'
import { cleanupEphemeralVmRuntime } from './ephemeral-vm-runtime-service'
import { removeEphemeralVmRuntimeSshTarget } from './ephemeral-vm-runtime-ssh-cleanup'
import { removeRuntimeOwnedSshTarget } from './ephemeral-vm-runtime-ssh'
import { getRuntimeRecipeContext } from './ipc/ephemeral-vm-recipe-context'

/** Destroys a recipe runtime's machine, then drops the paired environment or owned SSH target
 *  that pointed at it. */
export async function teardownEphemeralVmRuntime(
  store: Store,
  userDataPath: string,
  runtimeId: string
): Promise<EphemeralVmRuntimeRecord> {
  const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
  if (!runtime) {
    throw new Error(`Unknown ephemeral VM runtime: ${runtimeId}`)
  }
  if (!runtime.repoId) {
    throw new Error(`Ephemeral VM runtime has no repo id: ${runtimeId}`)
  }
  let result
  if (runtime.cleanupStatus === 'succeeded') {
    result = { ok: true as const, runtime, skipped: false }
  } else {
    let resolved: ReturnType<typeof getRuntimeRecipeContext>
    try {
      resolved = getRuntimeRecipeContext(store, userDataPath, runtime.id)
    } catch (error) {
      const failed = updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
        status: 'cleanup_failed',
        cleanupStatus: 'failed',
        cleanupLastAttemptAt: Date.now(),
        cleanupLastError: error instanceof Error ? error.message : String(error)
      })
      return removeEphemeralVmRuntimeSshTarget({
        userDataPath,
        runtime: failed,
        removeTarget: removeRuntimeOwnedSshTarget
      })
    }
    result = await cleanupEphemeralVmRuntime({
      userDataPath,
      repoPath: resolved.repo.repo.path,
      recipe: resolved.recipe,
      runtimeId: runtime.id
    })
  }
  if (result.ok && runtime.runtimeEnvironmentId) {
    try {
      removeEnvironment(userDataPath, runtime.runtimeEnvironmentId)
    } catch {
      // Cleanup of provider resources matters more than hiding a stale local
      // environment row; users can still remove that manually.
    }
  }
  if (!result.ok) {
    return result.runtime
  }
  return removeEphemeralVmRuntimeSshTarget({
    userDataPath,
    runtime: result.runtime,
    removeTarget: removeRuntimeOwnedSshTarget
  })
}
