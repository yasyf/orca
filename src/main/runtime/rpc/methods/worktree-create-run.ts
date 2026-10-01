import type { z } from 'zod'
import {
  finishAutomationWorkspaceProvenanceRequest,
  releaseAutomationWorkspaceProvenanceRequest,
  resolveAutomationWorkspaceProvenance
} from '../../../automations/workspace-provenance'
import { getLocalWorktreeCatalogVersion } from '../../../local-worktree-scan-generation'
import { buildCliWorkspaceProvenance } from '../../../../shared/cli-workspace-provenance'
import type { Repo } from '../../../../shared/repo-types'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import type { RpcContext } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { buildManagedWorktreeCreateArgs } from './worktree-create-args'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'
import type { WorktreeCreate } from './worktree-create-schemas'

type ManagedWorktreeCreateArgs = Parameters<OrcaRuntimeService['createManagedWorktree']>[0]

/** The envelope every worktree-creating method shares: dedupe, provenance, catalog stamp.
 *  `create` names the repo whose catalog now holds the worktree. */
export function runRpcWorktreeCreate(
  params: z.infer<typeof WorktreeCreate>,
  context: RpcContext,
  create: (
    args: ManagedWorktreeCreateArgs,
    repo: Repo
  ) => Promise<{ result: CreateWorktreeResult; catalogRepoId: string }>
) {
  // Why: mobile retries a create cut off by a connection migration with the same
  // clientMutationId; dedupe returns the in-flight worktree. No key runs plainly.
  return context.runtime.dedupeWorktreeCreate(params.repo, params.clientMutationId, async () => {
    const { runtime } = context
    const repo = await runtime.showRepo(params.repo)
    const automationProvenance = resolveAutomationWorkspaceProvenance({
      authority: runtime,
      repoSelector: params.repo,
      repo,
      request: params.automationProvenanceRequest
    })
    // Why: provenance tokens are reserved before creation so retries can recover,
    // but failed create attempts must release the reservation for a safe retry.
    try {
      const { result, catalogRepoId } = await create(
        buildManagedWorktreeCreateArgs(
          params,
          {
            automationProvenance,
            cliProvenance: buildCliWorkspaceProvenance(params.cliProvenanceRequest, {
              startupAgent: params.startupAgent ?? params.createdWithAgent,
              createdAt: Date.now()
            }),
            creatorProvenance: resolveRpcWorkspaceCreatorProvenance(context)
          },
          context.clientKind ? { clientKind: context.clientKind } : {}
        ),
        repo
      )
      finishAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
      // Why stamped here: the create's change notification has bumped the generation, so this
      // names the catalog that contains the new worktree.
      const stamped = { ...result, catalogVersion: getLocalWorktreeCatalogVersion(catalogRepoId) }
      // Why: agent callers need a stable dispatch target without traversing
      // terminal-list layout duplicates after creating the worktree.
      return params.startupAgent && result.startupTerminal?.handle
        ? { ...stamped, agentTerminalHandle: result.startupTerminal.handle }
        : stamped
    } catch (error) {
      releaseAutomationWorkspaceProvenanceRequest(params.automationProvenanceRequest)
      throw error
    }
  })
}
