import * as core from '@actions/core';

/**
 * An error a maintainer can fix by changing the workflow: a bad input, a token
 * that cannot see the pull request, a missing permissions block.
 */
export class ConfigurationError extends Error {
  override readonly name: string = 'ConfigurationError';
}

/** A malformed action input. */
export class InputError extends ConfigurationError {
  override readonly name = 'InputError';
}

interface ErrorShape {
  status?: unknown;
  message?: unknown;
  cause?: unknown;
  errors?: unknown;
  request?: { method?: unknown; url?: unknown } | undefined;
  response?: { status?: unknown; headers?: Record<string, unknown>; data?: unknown } | undefined;
}

/**
 * Lets an unknown value be probed for the fields Octokit errors carry, without
 * every caller repeating the same cast.
 */
export function shapeOf(error: unknown): ErrorShape {
  return typeof error === 'object' && error !== null ? (error as ErrorShape) : {};
}

/**
 * Reads an HTTP status off an unknown error value. Octokit puts it on the error
 * itself; some wrappers only carry the response.
 */
export function statusOf(error: unknown): number | undefined {
  const shape = shapeOf(error);
  if (typeof shape.status === 'number') {
    return shape.status;
  }
  if (typeof shape.response?.status === 'number') {
    return shape.response.status;
  }
  return undefined;
}

interface GraphqlError {
  type?: string;
  message?: string;
}

/**
 * A failed GraphQL query is an HTTP 200 carrying an `errors` array, so it never
 * has a status and has to be classified on the error types instead.
 */
export function graphqlErrorsOf(error: unknown): GraphqlError[] {
  const shape = shapeOf(error);
  const errors = [shape.errors, shapeOf(shape.response).errors].find(Array.isArray) ?? [];
  return errors.filter(
    (entry): entry is GraphqlError => typeof entry === 'object' && entry !== null,
  );
}

/** GraphQL error types that mean the token or the permissions block is wrong. */
const CONFIGURATION_GRAPHQL_TYPES = new Set(['FORBIDDEN', 'INSUFFICIENT_SCOPES', 'NOT_FOUND']);

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const shape = shapeOf(error);
  if (typeof shape.message === 'string' && shape.message !== '') {
    return shape.message;
  }
  const text = String(error);
  return text === '[object Object]' ? JSON.stringify(error) : text;
}

/**
 * A 403 is ambiguous: GitHub returns it both for a token that lacks a scope and
 * for a rate limit it has already refused to serve. Only the first is a
 * configuration error.
 */
export function isRateLimited(error: unknown): boolean {
  if (/rate limit/i.test(messageOf(error))) {
    return true;
  }
  const headers = shapeOf(error).response?.headers ?? {};
  return headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] !== undefined;
}

/**
 * 401 and 403 are treated as configuration errors: a bad token, or a workflow
 * that does not declare the permissions the action needs. Rate-limit 403s are
 * excluded above.
 */
export function isConfigurationError(error: unknown): boolean {
  if (error instanceof ConfigurationError) {
    return true;
  }
  const status = statusOf(error);
  if (status === 401) {
    return true;
  }
  if (status === 403) {
    return !isRateLimited(error);
  }
  return graphqlErrorsOf(error).some(
    (entry) => typeof entry.type === 'string' && CONFIGURATION_GRAPHQL_TYPES.has(entry.type),
  );
}

/** Everything known about an error, so no annotation is ever empty. */
export function describeError(error: unknown): string {
  const shape = shapeOf(error);
  const parts = [messageOf(error)];

  const status = statusOf(error);
  if (status !== undefined) {
    parts.push(`status ${status}`);
  }

  const method = shape.request?.method;
  const url = shape.request?.url;
  if (method !== undefined || url !== undefined) {
    parts.push(`request ${String(method ?? 'GET')} ${String(url ?? 'unknown')}`);
  }

  if (shape.cause !== undefined && shape.cause !== null) {
    parts.push(`cause ${messageOf(shape.cause)}`);
  }

  const graphql = graphqlErrorsOf(error)
    .map((entry) => `${entry.type ?? 'ERROR'}: ${entry.message ?? 'no message'}`)
    .join('; ');
  if (graphql !== '') {
    parts.push(`GraphQL ${graphql}`);
  }

  return parts.join(', ');
}

/**
 * This action is designed to be deployed as a required check with no bypass, so
 * it fails closed only for errors a maintainer can actually fix, and fails open
 * for everything else.
 */
export function applyErrorPolicy(error: unknown, eventName?: string): void {
  const description = describeError(error);

  if (isConfigurationError(error)) {
    const hint =
      statusOf(error) === 403 && eventName === 'pull_request'
        ? ' Fork pull requests need this action to run on pull_request_target.'
        : '';
    core.setOutput('outcome', 'failed');
    core.setFailed(
      `conflict-label could not talk to the GitHub API: ${description}. ` +
        'Check the token input and the workflow permissions block (pull-requests: write, issues: write).' +
        hint,
    );
    return;
  }

  core.setOutput('outcome', 'failed-open');
  core.warning(`conflict-label did not complete and is passing anyway: ${description}`);
}
