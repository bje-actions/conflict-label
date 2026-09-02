import * as core from '@actions/core';
import { context } from '@actions/github';
import { createClient, createOctokit } from './github';
import { applyErrorPolicy } from './policy';
import { run } from './run';

run(
  {
    label: core.getInput('label'),
    pollSeconds: core.getInput('poll-seconds'),
    prNumber: core.getInput('pr-number'),
    token: core.getInput('token'),
  },
  context,
  {
    createClient: (token) =>
      createClient(createOctokit(token), { owner: context.repo.owner, repo: context.repo.repo }),
  },
).catch((error: unknown) => {
  // run() already applies the policy to anything the action throws. This is the
  // last resort that keeps a failure inside the policy itself from surfacing as
  // an unhandled rejection.
  applyErrorPolicy(error, context.eventName);
});
