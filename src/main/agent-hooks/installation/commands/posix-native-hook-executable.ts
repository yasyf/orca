import { join } from 'node:path'

export const POSIX_NATIVE_HOOK_EXECUTABLE_NAME = 'orca-agent-hook'

/** macOS and Linux packages bundle it beside `bin/orca`; dev paths may resolve without a file. */
export function resolveBundledPosixNativeHookExecutable(): string | null {
  // CLI builds lack the Electron Process type.
  const resourcesPath = 'resourcesPath' in process ? process.resourcesPath : undefined
  return (process.platform === 'darwin' || process.platform === 'linux') &&
    typeof resourcesPath === 'string' &&
    resourcesPath
    ? join(resourcesPath, 'bin', POSIX_NATIVE_HOOK_EXECUTABLE_NAME)
    : null
}
