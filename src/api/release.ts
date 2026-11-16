import { createHash } from 'node:crypto';
import { CliError, downloadArtifact, sync, type ApiOptions, type SyncDeploymentResult } from './client';

/**
 * Exit codes are part of the contract: pipelines branch on them.
 *   0 downloaded   3 nothing to do   4 no release   1 error   2 usage
 */
export const EXIT_NO_CHANGE = 3;
export const EXIT_NO_RELEASE = 4;

export type Fetched =
  | { action: 'no_change' }
  | { action: 'load'; result: SyncDeploymentResult; buffer: Buffer; digest: string; verified: boolean };

const describeFailure = (result: SyncDeploymentResult, project: string, target: string): CliError => {
  switch (result.action) {
    case 'no_access':
      return new CliError(
        `The CI token cannot reach project "${project}". Check the project key and that the token was issued in that project's settings.`,
      );
    case 'no_release':
      return new CliError(
        `Nothing to pull for "${target}" in project "${project}": no release yet, or nothing live in that environment.`,
        EXIT_NO_RELEASE,
      );
    case 'error':
      return new CliError(`Could not resolve "${target}" in project "${project}": ${result.code ?? 'unknown error'}`);
    default:
      return new CliError(`Unexpected response for "${target}" in project "${project}": ${result.action}`);
  }
};

/** Resolves a target through rules-sync, then downloads its artifact and checks it against the published digest. */
export const fetchArtifact = async (
  options: ApiOptions,
  project: string,
  target: string,
  currentId?: string,
): Promise<Fetched> => {
  // A `current` id is echoed back to the server, which answers no_change
  // rather than re-serving an artifact the caller already holds.
  const current = currentId ? { commitId: currentId, releaseId: currentId } : undefined;

  const response = await sync(options, [{ project, target, ...(current && { current }) }]);
  const result = response.deployments[0];

  if (!result) {
    throw new CliError('The server returned no result for this deployment.');
  }
  if (result.action === 'no_change') {
    return { action: 'no_change' };
  }
  if (result.action !== 'load' || !result.artifact) {
    throw describeFailure(result, project, target);
  }

  const buffer = await downloadArtifact(options, result.artifact);
  const digest = createHash('sha256').update(buffer).digest('hex');

  // Verified only when the server supplied a digest; Studio always does.
  if (result.artifact.sha256 && result.artifact.sha256.toLowerCase() !== digest) {
    throw new CliError('Artifact checksum mismatch: the download does not match what the server published.');
  }

  return { action: 'load', result, buffer, digest, verified: Boolean(result.artifact.sha256) };
};
