import type { BrowserWindow } from 'electron'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import { getAppEnvironment } from '../../shared/app-environment'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { createRemoteWorktree } from '../ipc/worktree-remote'
import {
  findExactRepoOwner,
  isCapturedRepoCurrent
} from '../ipc/worktrees/listing/worktree-host-ownership'
import type { Store } from '../persistence'
import { adoptProvisionedRootSshCheckout } from '../provisioned-root-ssh-adoption'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { WorktreeStartupFollowup } from './runtime-worktree-agent-startup'

export type RuntimeRemoteWorktreeCreateArgs = Omit<
  RuntimeManagedWorktreeCreateArgs,
  'repoSelector'
> & {
  startupFollowup?: WorktreeStartupFollowup
}

export async function requestRuntimeRemoteWorktree(
  repo: Repo,
  args: RuntimeRemoteWorktreeCreateArgs,
  store: RuntimeStore
): Promise<CreateWorktreeResult> {
  const headlessWindow = {
    isDestroyed: () => false,
    webContents: { send: () => undefined }
  } as unknown as BrowserWindow
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: desktop and orcad build the runtime from the persisted Store; RuntimeStore only narrows it.
  const persistedStore = store as unknown as Store
  const createArgs = {
    repoId: repo.id,
    name: args.name,
    ...(args.displayName ? { displayName: args.displayName } : {}),
    ...(args.displayNameKind ? { displayNameKind: args.displayNameKind } : {}),
    ...(args.baseBranch ? { baseBranch: args.baseBranch } : {}),
    ...(args.compareBaseRef ? { compareBaseRef: args.compareBaseRef } : {}),
    ...(args.branchNameOverride ? { branchNameOverride: args.branchNameOverride } : {}),
    ...(args.runHooks ? { setupDecision: 'run' as const } : {}),
    ...(!args.runHooks && args.setupDecision ? { setupDecision: args.setupDecision } : {}),
    ...(args.sparseCheckout ? { sparseCheckout: args.sparseCheckout } : {}),
    ...(args.linkedIssue != null ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR != null ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
      : {}),
    ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
      ? {
          linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey
        }
      : {}),
    ...(args.linkedGitLabMR != null ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.linkedGitLabIssue != null ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedBitbucketPR != null ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
    ...(args.linkedAzureDevOpsPR != null ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR } : {}),
    ...(args.linkedGiteaPR != null ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
    ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {}),
    ...(args.pushTarget ? { pushTarget: args.pushTarget } : {}),
    ...(args.workspaceStatus ? { workspaceStatus: args.workspaceStatus as never } : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.createdWithAgent ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.pendingFirstAgentMessageRename ? { pendingFirstAgentMessageRename: true } : {}),
    ...(args.nameWasGenerated === true ? { nameWasGenerated: true } : {}),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {})
  }
  const result = args.provisionedRoot
    ? await adoptProvisionedRoot(repo, { ...createArgs, ...args.provisionedRoot }, persistedStore)
    : await createRemoteWorktree(createArgs, repo, persistedStore, headlessWindow)
  if (args.comment !== undefined) {
    store.setWorktreeMeta(result.worktree.id, { comment: args.comment })
    result.worktree.comment = args.comment
  }
  return result
}

async function adoptProvisionedRoot(
  repo: Repo,
  request: Omit<
    Parameters<typeof adoptProvisionedRootSshCheckout>[0]['request'],
    'executionHostId'
  >,
  store: Store
): Promise<CreateWorktreeResult> {
  const executionHostId = getRepoExecutionHostId(repo)
  const owner = findExactRepoOwner(store, repo.id, executionHostId)
  if (!owner || isFolderRepo(owner)) {
    throw new Error('Provisioned-root repository ownership is missing or ambiguous.')
  }
  return adoptProvisionedRootSshCheckout({
    userDataPath: getAppEnvironment().getPath('userData'),
    request: { ...request, executionHostId },
    repo: owner,
    store,
    isRepoCurrent: () => isCapturedRepoCurrent(store, owner, executionHostId)
  })
}
