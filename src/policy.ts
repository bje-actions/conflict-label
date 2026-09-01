import * as core from '@actions/core';

/**
 * Reads an HTTP status off an unknown error value.
 */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  const status = (error as { status: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * 401 and 403 are deterministic configuration errors: a bad token, or a
 * workflow that does not declare the permissions the action needs. Every other
 * error is transient or unexpected and must not block a merge.
 */
export function isConfigurationError(error: unknown): boolean {
  const status = statusOf(error);
  return status === 401 || status === 403;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The reliability contract. This check gates every merge with no bypass, so it
 * fails closed only for errors a maintainer can actually fix, and fails open
 * for everything else.
 */
export function applyErrorPolicy(error: unknown): void {
  const message = messageOf(error);
  if (isConfigurationError(error)) {
    core.setFailed(
      `conflict-label could not authenticate to the GitHub API (${statusOf(error)}): ${message}. ` +
        'Check the token input and the workflow permissions block (pull-requests: write, issues: write).',
    );
    return;
  }
  core.warning(`conflict-label did not complete and is passing anyway: ${message}`);
}
