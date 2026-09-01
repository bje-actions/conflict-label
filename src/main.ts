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
  applyErrorPolicy(error, context.eventName);
});
