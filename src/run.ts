import * as core from '@actions/core';
import type { PullRequestClient } from './github';
import { applyErrorPolicy } from './policy';

export const CONFLICTING = 'DIRTY';
export const UNKNOWN = 'UNKNOWN';

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
}

export interface ActionContext {
  eventName: string;
  payload: { pull_request?: { number?: number } | undefined };
}

/**
 * Turns raw action inputs plus the webhook context into run options. The
 * pr-number input wins so the smoke test and workflow_call callers can target
 * a pull request explicitly.
 */
export function resolveOptions(inputs: ActionInputs, ctx: ActionContext): RunOptions {
  const fromContext = ctx.payload.pull_request?.number;
  const prNumber = inputs.prNumber ? Number(inputs.prNumber) : fromContext;
  return {
    eventName: ctx.eventName,
    prNumber,
    label: inputs.label || 'conflicting',
    pollSeconds: Number(inputs.pollSeconds || '120'),
  };
}

export interface RunOptions {
  eventName: string;
  prNumber: number | undefined;
  label: string;
  pollSeconds: number;
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
  let attempt = 0;
  let status = await client.mergeStateStatus(prNumber);

  while (status === UNKNOWN) {
    const wait = backoffMs(attempt);
    if (Date.now() + wait > deadline) {
      return UNKNOWN;
    }
    core.info(`Merge state is UNKNOWN, retrying in ${wait / 1000}s.`);
    await sleepFn(wait);
    attempt += 1;
    status = await client.mergeStateStatus(prNumber);
  }

  return status;
}

export async function run(
  options: RunOptions,
  client: PullRequestClient,
  sleepFn: Sleep = sleep,
): Promise<void> {
  try {
    if (options.eventName === 'merge_group') {
      core.info('merge_group event, nothing to label.');
      return;
    }

    if (options.prNumber === undefined) {
      core.info('No pull request in context, nothing to label.');
      return;
    }

    const status = await resolveMergeState(client, options.prNumber, options.pollSeconds, sleepFn);

    if (status === UNKNOWN) {
      core.notice(
        `Merge state was still UNKNOWN after ${options.pollSeconds}s, leaving the "${options.label}" label untouched.`,
      );
      return;
    }

    if (status === CONFLICTING) {
      await client.addLabel(options.prNumber, options.label);
      core.info(`Pull request #${options.prNumber} is conflicting, added "${options.label}".`);
      return;
    }

    await client.removeLabel(options.prNumber, options.label);
    core.info(
      `Pull request #${options.prNumber} is ${status}, removed "${options.label}" if present.`,
    );
  } catch (error) {
    applyErrorPolicy(error);
  }
}
