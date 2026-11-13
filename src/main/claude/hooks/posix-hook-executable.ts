import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentHookInstallStatus } from '../../../shared/agent-hook-listener/configuration/agent-hook-types'
import { writeManagedScript } from '../../agent-hooks/installation/scripts/managed-hook-script-write'
import { refreshManagedScriptIfPresent } from '../../agent-hooks/installation/scripts/managed-hook-script-refresh'
import {
  POSIX_NATIVE_HOOK_EXECUTABLE_NAME,
  resolveBundledPosixNativeHookExecutable
} from '../../agent-hooks/installation/commands/posix-native-hook-executable'

export function getPosixClaudeHookExecutablePath(scriptPath: string): string {
  return join(dirname(scriptPath), POSIX_NATIVE_HOOK_EXECUTABLE_NAME)
}

/** Copy bytes unchanged to keep the app's code signature; return null to register the script. */
export function installPosixClaudeHookExecutable(scriptPath: string): string | null {
  const source = resolveBundledPosixNativeHookExecutable()
  if (!source || !existsSync(source)) {
    return null
  }
  const destination = getPosixClaudeHookExecutablePath(scriptPath)
  writeManagedScript(destination, readFileSync(source))
  return destination
}

export async function refreshPosixClaudeHookExecutable(scriptPath: string): Promise<void> {
  const source = resolveBundledPosixNativeHookExecutable()
  if (!source || !existsSync(source)) {
    return
  }
  await refreshManagedScriptIfPresent(
    getPosixClaudeHookExecutablePath(scriptPath),
    await readFile(source)
  )
}

export function getPosixClaudeHookFileStatus(
  status: AgentHookInstallStatus,
  scriptPath: string,
  executableRegistered: boolean
): AgentHookInstallStatus {
  if (
    status.state === 'installed' &&
    executableRegistered &&
    !existsSync(getPosixClaudeHookExecutablePath(scriptPath))
  ) {
    return { ...status, state: 'partial', detail: 'Managed Claude hook executable is missing' }
  }
  return status
}
