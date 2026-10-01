import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { EphemeralVmRecipeDoctorResult } from '../../shared/ephemeral-vm-recipes'
import { redactEphemeralVmRecipeDiagnosticText } from '../../shared/ephemeral-vm-recipe-diagnostics'
// Why: import directly from the doctor module (not the barrel) — it uses Node
// fs/path and must stay out of the browser bundle that imports the barrel.
import { doctorEphemeralVmRecipe } from '../../shared/ephemeral-vm-recipe-doctor'
import {
  provisionEphemeralVmWorkspace,
  resolveEphemeralVmRecipeSource,
  type EphemeralVmWorkspaceProvisionResult
} from '../ephemeral-vm-workspace-provisioning'
import {
  getRecipeRepo,
  listRecipeCatalog,
  listRecipes,
  type EphemeralVmRecipeCatalogEntry
} from './ephemeral-vm-recipe-context'
import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'
import type { PluginService } from '../plugins/plugin-service'
import { getApprovedPluginVmRecipes } from '../plugins/plugin-approved-vm-recipes'

const activeProvisionControllers = new Map<string, AbortController>()

export function registerEphemeralVmHandlers(store: Store, pluginService?: PluginService): void {
  ipcMain.removeHandler('ephemeralVm:listRecipes')
  ipcMain.removeHandler('ephemeralVm:listRecipeCatalog')
  ipcMain.removeHandler('ephemeralVm:doctor')
  ipcMain.removeHandler('ephemeralVm:provision')
  ipcMain.removeHandler('ephemeralVm:cancelProvision')
  registerEphemeralVmRuntimeHandlers(store)

  ipcMain.handle('ephemeralVm:listRecipes', async (_event, args: { repoId: string }) => {
    return listRecipes(store, args.repoId, await getApprovedPluginVmRecipes(pluginService))
  })

  ipcMain.handle(
    'ephemeralVm:listRecipeCatalog',
    async (): Promise<EphemeralVmRecipeCatalogEntry[]> => {
      return listRecipeCatalog(store, await getApprovedPluginVmRecipes(pluginService))
    }
  )

  ipcMain.handle(
    'ephemeralVm:doctor',
    async (
      _event,
      args: { repoId: string; recipeId: string }
    ): Promise<EphemeralVmRecipeDoctorResult> => {
      const repo = getRecipeRepo(store, args.repoId)
      if (!repo.ok) {
        return repo.doctor(args.recipeId)
      }
      const pluginRecipes = await getApprovedPluginVmRecipes(pluginService)
      return doctorEphemeralVmRecipe({
        repoPath: repo.repo.path,
        recipeId: args.recipeId,
        recipes: listRecipes(store, args.repoId, pluginRecipes).recipes,
        localExecutionSupported: true
      })
    }
  )

  ipcMain.handle(
    'ephemeralVm:provision',
    async (
      _event,
      args: {
        repoId: string
        recipeId: string
        workspaceName?: string
        projectId?: string
        workspaceId?: string
        branch?: string
        ref?: string
        provisionId?: string
      }
    ): Promise<EphemeralVmWorkspaceProvisionResult> => {
      const source = resolveEphemeralVmRecipeSource(
        store,
        args.repoId,
        args.recipeId,
        await getApprovedPluginVmRecipes(pluginService)
      )
      if (!source.ok) {
        return { ok: false, error: source.error, stdout: '', stderr: '' }
      }
      const controller = args.provisionId ? new AbortController() : null
      if (args.provisionId && controller) {
        activeProvisionControllers.set(args.provisionId, controller)
      }
      const sendProvisionEvent = (stream: 'stdout' | 'stderr', chunk: string): void => {
        if (!args.provisionId) {
          return
        }
        _event.sender.send('ephemeralVm:provisionEvent', {
          provisionId: args.provisionId,
          stream,
          chunk: redactEphemeralVmRecipeDiagnosticText(chunk)
        })
      }
      // Why: keep the controller registered across BOTH the recipe-create phase AND
      // the post-create SSH-connect/provider-wait phase, so cancelProvision can still
      // abort during the up-to-10s SSH connect window. Removing it in the provision
      // promise's own .finally() would deregister it before SSH connect even starts.
      try {
        return await provisionEphemeralVmWorkspace({
          store,
          userDataPath: app.getPath('userData'),
          repo: source.repo,
          recipe: source.recipe,
          projectId: args.projectId,
          workspaceId: args.workspaceId,
          workspaceName: args.workspaceName,
          ...(args.branch ? { branch: args.branch } : {}),
          ...(args.ref ? { ref: args.ref } : {}),
          ...(controller ? { signal: controller.signal } : {}),
          onStdout: (chunk) => sendProvisionEvent('stdout', chunk),
          onStderr: (chunk) => sendProvisionEvent('stderr', chunk)
        })
      } finally {
        if (args.provisionId) {
          activeProvisionControllers.delete(args.provisionId)
        }
      }
    }
  )

  ipcMain.handle(
    'ephemeralVm:cancelProvision',
    (_event, args: { provisionId: string }): { cancelled: boolean } => {
      const controller = activeProvisionControllers.get(args.provisionId)
      if (!controller) {
        return { cancelled: false }
      }
      controller.abort()
      activeProvisionControllers.delete(args.provisionId)
      return { cancelled: true }
    }
  )
}
