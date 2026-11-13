import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, describe, expect, it } from 'vitest'
import type * as GitBashModule from '../../pty/shell-startup/git-bash'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

const { gitBashAvailableMock } = vi.hoisted(() => ({ gitBashAvailableMock: { value: true } }))
vi.mock('../../pty/shell-startup/git-bash', async (importOriginal) => ({
  ...(await importOriginal<typeof GitBashModule>()),
  isGitBashAvailable: () => gitBashAvailableMock.value
}))

import { ClaudeHookService } from '../hook-service'

describe('ClaudeHookService.install', () => {
  it('does not re-install a managed statusLine the user deleted, until remove() resets the opt-out', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-statusline-optout-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const settingsPath = join(tmpHome, '.claude', 'settings.json')
      new ClaudeHookService().install()
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeTruthy()

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      delete settings.statusLine
      writeFileSync(settingsPath, JSON.stringify(settings))

      new ClaudeHookService().install()
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeUndefined()

      new ClaudeHookService().remove()
      new ClaudeHookService().install()
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeTruthy()
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'registers the bundled native hook in exec form and removes it with the script entries',
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-native-hook-'))
      const resourcesPath = join(tmpHome, 'resources')
      mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
      writeFileSync(join(resourcesPath, 'bin', 'orca-agent-hook'), 'native hook')
      Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true })
      vi.stubEnv('HOME', tmpHome)
      try {
        const service = new ClaudeHookService()
        expect(service.install({ claudeVersion: '2.1.300' }).state).toBe('installed')
        const hooksDir = join(tmpHome, '.orca', 'agent-hooks')
        expect(readFileSync(join(hooksDir, 'orca-agent-hook'), 'utf-8')).toBe('native hook')
        const settingsPath = join(tmpHome, '.claude', 'settings.json')
        const { hooks } = JSON.parse(readFileSync(settingsPath, 'utf-8'))
        expect(hooks.PreToolUse[0].hooks[0]).toMatchObject({
          type: 'command',
          command: join(hooksDir, 'orca-agent-hook'),
          args: ['claude', join(hooksDir, 'claude-hook.sh')]
        })

        expect(service.remove().state).toBe('not_installed')
      } finally {
        Reflect.deleteProperty(process, 'resourcesPath')
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
      }
    }
  )
})
