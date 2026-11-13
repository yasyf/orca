import {
  buildManagedCommandHook,
  MANAGED_HOOK_TIMEOUT_SECONDS
} from '../../agent-hooks/installation/configuration/hook-config-schema'
import type { HookCommandConfig } from '../../agent-hooks/installation/configuration/hook-config-schema'
import { getWindowsNativeHookAgent } from '../../agent-hooks/installation/commands/windows-native-hook-executable'
import {
  CLAUDE_HOOK_SETTINGS,
  getManagedLifecycleHook,
  getRemoteManagedEventCommand,
  type NativeHookFormOptions
} from './hook-settings'

// Why 130 s: a worker's request waits up to Orca's 122 s hold, past Claude's own 2:00 auto-block.
const CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS = 130

/** The managed entry for one Claude hook event; only PermissionRequest waits longer than the shared timeout. */
export function getManagedEventHook(
  eventName: string,
  scriptPath: string,
  settings = CLAUDE_HOOK_SETTINGS,
  nativeHookPath: string | null = null,
  options: NativeHookFormOptions = {}
): HookCommandConfig {
  if (process.platform === 'win32') {
    return getManagedLifecycleHook(scriptPath, settings, nativeHookPath, options)
  }
  const timeout =
    eventName === 'PermissionRequest' ? CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS : undefined
  // Exec form starts the native hook alone; the script path lets reinstalls find the entry.
  if (nativeHookPath && options.execForm) {
    return {
      type: 'command',
      command: nativeHookPath,
      args: [getWindowsNativeHookAgent(scriptPath), scriptPath],
      timeout: timeout ?? MANAGED_HOOK_TIMEOUT_SECONDS
    }
  }
  return buildManagedCommandHook(getRemoteManagedEventCommand(eventName, scriptPath), timeout)
}
