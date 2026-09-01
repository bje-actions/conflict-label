import * as core from '@actions/core';
import type { PullRequestClient } from './github';
import { applyErrorPolicy, InputError } from './policy';

export const CONFLICTING = 'DIRTY';
export const UNKNOWN = 'UNKNOWN';

export const DEFAULT_LABEL = 'conflicting';
export const DEFAULT_POLL_SECONDS = 120;

export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Exponential backoff, capped so a long budget still polls regularly. */
export function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000, 15_000);
}

export interface ActionInputs {
  label: string;
  pollSeconds: string;
  prNumber: string;
  token: string;
}

export interface ActionContext {
  eventName: string;
  payload: { pull_request?: { number?: number } | undefined };
}

export interface RunOptions {
  eventName: string;
  prNumber: number | undefined;
  label: string;
  pollSeconds: number;
}

export interface RunDeps {
  createClient: (token: string) => PullRequestClient;
  sleep?: Sleep;
}

/**
 * Action inputs are always strings, and a plausible looking value such as "2m"
 * would otherwise become NaN and turn the poll loop into an infinite one.
 */
export function parseCount(value: string, name: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InputError(`Input "${name}" must be a whole number of zero or more, got "${value}".`);
  }
  return Number(trimmed);
}

export function resolveToken(value: string): string {
  const token = value.trim();
  if (token === '') {
    throw new InputError('Input "token" is empty. Pass a token with pull-requests: write.');
  }
  return token;
}

export function resolveOptions(inputs: ActionInputs, ctx: ActionContext): RunOptions {
  // An explicit pr-number input overrides the pull request in the webhook
  // payload, for events that carry no pull request.
  const prNumber = inputs.prNumber.trim()
    ? parseCount(inputs.prNumber, 'pr-number')
    : ctx.payload.pull_request?.number;

  return {
    eventName: ctx.eventName,
    prNumber,
    label: inputs.label.trim() || DEFAULT_LABEL,
    pollSeconds: inputs.pollSeconds.trim()
      ? parseCount(inputs.pollSeconds, 'poll-seconds')
      : DEFAULT_POLL_SECONDS,
  };
}

/**
 * GitHub computes mergeability lazily, so a freshly pushed pull request reports
 * UNKNOWN until a background job finishes. Poll until it settles or the budget
 * is spent.
 */
export async function resolveMergeState(
  client: PullRequestClient,
  prNumber: number,
  pollSeconds: number,
  sleepFn: Sleep,
): Promise<string> {
  const deadline = Date.now() + pollSeconds * 1000;
  if (!Number.isFinite(deadline)) {
    throw new InputError(`Cannot poll for ${pollSeconds} seconds.`);
  }

  for (let attempt = 0; ; attempt += 1) {
    const status = await client.mergeStateStatus(prNumber);
    if (status !== UNKNOWN) {
      return status;
    }

    const wait = backoffMs(attempt);
    if (Date.now() + wait > deadline) {
      return UNKNOWN;
    }
    core.info(`Merge state is UNKNOWN, retrying in ${wait / 1000}s.`);
    await sleepFn(wait);
  }
}

/** The decision itself. Throws; the caller applies the error policy. */
export async function syncLabel(
  options: RunOptions,
  client: PullRequestClient,
  sleepFn: Sleep,
): Promise<void> {
  const { eventName, prNumber, label, pollSeconds } = options;

  if (eventName === 'merge_group') {
    core.info('merge_group event, nothing to label.');
    return;
  }

  if (prNumber === undefined) {
    core.info('No pull request in context, nothing to label.');
    return;
  }

  const status = await resolveMergeState(client, prNumber, pollSeconds, sleepFn);

  if (status === UNKNOWN) {
    core.notice(
      `Merge state was still UNKNOWN after ${pollSeconds}s, leaving the "${label}" label untouched.`,
    );
    return;
  }

  if (status === CONFLICTING) {
    await client.addLabel(prNumber, label);
    core.info(`Pull request #${prNumber} is conflicting, added "${label}".`);
    return;
  }

  await client.removeLabel(prNumber, label);
  core.info(`Pull request #${prNumber} is ${status}, removed "${label}" if present.`);
}

export async function run(inputs: ActionInputs, ctx: ActionContext, deps: RunDeps): Promise<void> {
  try {
    const options = resolveOptions(inputs, ctx);
    const client = deps.createClient(resolveToken(inputs.token));
    await syncLabel(options, client, deps.sleep ?? sleep);
    core.setOutput('outcome', 'completed');
  } catch (error) {
    applyErrorPolicy(error, ctx.eventName);
  }
}
