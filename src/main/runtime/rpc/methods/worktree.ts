import { getLocalWorktreeCatalogVersion } from '../../../local-worktree-scan-generation'
import { getExplicitWorktreeIdSelector } from '../../runtime-worktree-selection'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { displayNameUpdatePinsLabel } from '../../../../shared/worktree/display-name-provenance'
import { defineMethod } from '../core'
import { runRpcWorktreeCreate } from './worktree-create-run'
import { WORKTREE_CREATE_FROM_RECIPE_METHOD } from './worktree-create-from-recipe'
import { resolvePairedCallerHostId } from './paired-caller-host-id'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { WorktreeCreate, WorktreePrefetchCreateBase } from './worktree-create-schemas'
import {
  WorktreeActivate,
  WorktreeForceDeleteBranch,
  WorktreeRemove,
  WorktreeResolveMrBase,
  WorktreeResolvePrBase,
  WorktreeSelector,
  WorktreeSet,
  WorktreeSortOrder,
  WorktreeTeardownMissingTerminalsParams
} from './worktree-schemas'
import { WORKTREE_CATALOG_METHODS } from './worktree-catalog-methods'

export const WORKTREE_METHODS = [
  ...WORKTREE_CATALOG_METHODS,
  defineMethod({
    name: 'worktree.teardownMissingTerminals',
    params: WorktreeTeardownMissingTerminalsParams,
    handler: async (params, { runtime }) =>
      runtime.teardownMissingManagedWorktreeTerminals(
        params.repo,
        params.worktreeIds,
        params.connectionId
      )
  }),
  defineMethod({
    name: 'worktree.lineageList',
    params: null,
    handler: async (_params, { runtime }) => ({
      lineage: await runtime.listWorktreeLineage(),
      workspaceLineage: await runtime.listWorkspaceLineage()
    })
  }),
  defineMethod({
    name: 'worktree.show',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => ({
      worktree: await runtime.showManagedWorktree(params.worktree)
    })
  }),
  defineMethod({
    name: 'worktree.sleep',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.sleepManagedWorktree(params.worktree)
  }),
  defineMethod({
    name: 'worktree.activate',
    params: WorktreeActivate,
    handler: async (params, { runtime, clientKind }) =>
      // Why: clientKind ('mobile'|'runtime') scopes the host-renderer slept-agent
      // wake to phones so web/desktop activation behavior is unchanged.
      runtime.activateManagedWorktree(params.worktree, {
        notifyClients: params.notifyClients !== false,
        clientKind,
        navigation: resolveRuntimeNavigationTarget({
          navigation: params.navigation,
          notifyClients: params.notifyClients,
          clientKind
        })
      })
  }),
  defineMethod({
    name: 'worktree.create',
    params: WorktreeCreate,
    handler: async (params, context) =>
      runRpcWorktreeCreate(params, context, async (args, repo) => ({
        result: await context.runtime.createManagedWorktree(args),
        catalogRepoId: repo.id
      }))
  }),
  WORKTREE_CREATE_FROM_RECIPE_METHOD,
  defineMethod({
    name: 'worktree.prefetchCreateBase',
    params: WorktreePrefetchCreateBase,
    handler: async (params, { runtime }) => {
      await runtime.prefetchManagedWorktreeCreateBase({
        repoSelector: params.repo,
        baseBranch: params.baseBranch
      })
      return null
    }
  }),
  defineMethod({
    name: 'worktree.set',
    params: WorktreeSet,
    handler: async (params, { runtime }) => ({
      worktree: await runtime.updateManagedWorktreeMeta(params.worktree, {
        displayName: params.displayName,
        ...(params.displayName !== undefined
          ? { displayNameIsPinned: displayNameUpdatePinsLabel(params.displayName) }
          : {}),
        linkedIssue: params.linkedIssue,
        linkedPR: params.linkedPR,
        suppressedGitHubPR: params.suppressedGitHubPR,
        linkedLinearIssue: params.linkedLinearIssue,
        linkedLinearIssueWorkspaceId: params.linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey: params.linkedLinearIssueOrganizationUrlKey,
        linkedGitLabMR: params.linkedGitLabMR,
        linkedGitLabIssue: params.linkedGitLabIssue,
        linkedBitbucketPR: params.linkedBitbucketPR,
        linkedAzureDevOpsPR: params.linkedAzureDevOpsPR,
        linkedGiteaPR: params.linkedGiteaPR,
        linkedWorkItem: params.linkedWorkItem,
        linkedTaskSourceContext: params.linkedTaskSourceContext,
        comment: params.comment,
        isArchived: params.isArchived,
        isUnread: params.isUnread,
        isPinned: params.isPinned,
        sortOrder: params.sortOrder,
        manualOrder: params.manualOrder,
        lastActivityAt: params.lastActivityAt,
        createdAt: params.createdAt,
        sparseDirectories: params.sparseDirectories,
        sparseBaseRef: params.sparseBaseRef,
        sparsePresetId: params.sparsePresetId,
        baseRef: params.baseRef,
        workspaceStatus: params.workspaceStatus,
        pushTarget: params.pushTarget,
        diffComments: params.diffComments,
        mobileDiffReview: params.mobileDiffReview,
        lineage:
          params.parentWorktree || params.noParent === true
            ? {
                parentWorktree: params.parentWorktree,
                noParent: params.noParent === true
              }
            : undefined
      } as Parameters<typeof runtime.updateManagedWorktreeMeta>[1])
    })
  }),
  defineMethod({
    name: 'worktree.persistSortOrder',
    params: WorktreeSortOrder,
    handler: async (params, { runtime }) =>
      runtime.persistManagedWorktreeSortOrder(params.orderedIds)
  }),
  defineMethod({
    name: 'worktree.resolvePrBase',
    params: WorktreeResolvePrBase,
    handler: async (params, { runtime }) =>
      runtime.resolveManagedPrBase({
        repoSelector: params.repo,
        prNumber: params.prNumber,
        headRefName: params.headRefName,
        baseRefName: params.baseRefName,
        isCrossRepository: params.isCrossRepository
      })
  }),
  defineMethod({
    name: 'worktree.resolveMrBase',
    params: WorktreeResolveMrBase,
    handler: async (params, { runtime }) =>
      runtime.resolveManagedMrBase({
        repoSelector: params.repo,
        mrIid: params.mrIid,
        sourceBranch: params.sourceBranch,
        targetBranch: params.targetBranch,
        isCrossRepository: params.isCrossRepository
      })
  }),
  defineMethod({
    name: 'worktree.rm',
    params: WorktreeRemove,
    handler: async (params, { runtime }) => {
      // Translate a paired client's runtime-local host spelling before host-qualified reads.
      let resolvedHostId = resolvePairedCallerHostId(
        () => runtime.listRepos(),
        params.worktree,
        params.hostId
      )
      // Older mobile clients omit hostId, so resolve through the ambiguity gate
      // before pinning removal. An ambiguous selector still fails closed: two
      // hosts own the id and an unqualified client cannot say which it meant.
      if (!resolvedHostId) {
        try {
          resolvedHostId = (await runtime.showManagedWorktree(params.worktree)).hostId
          if (!resolvedHostId) {
            throw new Error('worktree.rm could not resolve the workspace host')
          }
        } catch (error) {
          // 'selector_not_found' is not a failure to attribute — Git simply no
          // longer lists the path. A delete legitimately arrives in that state and
          // `removeManagedWorktree` handles it, so a stale workspace stays
          // deletable by a client that sends no host. Anything else propagates.
          if (!(error instanceof Error) || error.message !== 'selector_not_found') {
            throw error
          }
        }
      }
      // Why parsed, not resolved: an `id:` selector (what clients send) names its repo, and a second
      // resolution costs a scan and throws for an id two hosts share. Other selectors stay unstamped.
      const explicitWorktreeId = getExplicitWorktreeIdSelector(params.worktree)
      const repoId = explicitWorktreeId ? splitWorktreeId(explicitWorktreeId)?.repoId : undefined
      const result = await runtime.removeManagedWorktree(params.worktree, {
        force: params.force === true,
        runHooks: params.runHooks === true,
        allowUnverifiedPtyStop: params.allowUnverifiedPtyStop === true,
        allowFailedArchiveHook: params.allowFailedArchiveHook === true,
        ...(resolvedHostId ? { hostId: resolvedHostId } : {})
      })
      return {
        removed: true,
        ...result,
        ...(repoId ? { catalogVersion: getLocalWorktreeCatalogVersion(repoId) } : {})
      }
    }
  }),
  defineMethod({
    name: 'worktree.forceDeleteBranch',
    params: WorktreeForceDeleteBranch,
    handler: async (params, { runtime }) => {
      const hostId = resolvePairedCallerHostId(
        () => runtime.listRepos(),
        params.worktree,
        params.hostId
      )
      return hostId
        ? runtime.forceDeletePreservedBranch(
            params.worktree,
            params.branchName,
            params.expectedHead,
            hostId
          )
        : runtime.forceDeletePreservedBranch(
            params.worktree,
            params.branchName,
            params.expectedHead
          )
    }
  })
]
