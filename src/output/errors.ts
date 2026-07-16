export type ExitCode = 1 | 2 | 3 | 4;

/** An error whose message and exit code are user-facing contracts (see docs/PRD.md). */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** 404 on a skill detail/audit route; callers decide (gone vs not-found vs unaudited). */
export class NotFoundError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`404 for ${url}`);
    this.name = 'NotFoundError';
    this.url = url;
  }
}

export const badRequest = (apiMsg: string) =>
  new CliError(`skills.sh rejected the request (400): ${apiMsg}`, 2);

export const authMissing = () =>
  new CliError(
    'This command needs registry access. Set SKILLS_SH_API_KEY to a Vercel OIDC token ' +
      '(see README > Authentication). Offline features: scan, check --offline.',
    4,
  );

export const authRejected = () =>
  new CliError(
    'skills.sh rejected the token in SKILLS_SH_API_KEY (401). Vercel OIDC tokens expire ' +
      'after ~12h — refresh with: vercel env pull',
    4,
  );

export const skillNotFound = (id: string) =>
  new CliError(`Skill '${id}' not found in the registry.`, 1);

export const rateLimited = (retryAfterSeconds: number) =>
  new CliError(`Rate limited by skills.sh (429). Try again in ${retryAfterSeconds}s.`, 3);

export const unavailable503 = () =>
  new CliError('skills.sh is temporarily unavailable (503). Tried 3 times over 7s.', 3);

export const network = (detail: string) =>
  new CliError(
    `Could not reach skills.sh (${detail}). Check connectivity, or use --offline to run from cache.`,
    3,
  );

export const malformed = (detail: string) =>
  new CliError(`skills.sh returned an unparseable response (${detail}).`, 3);

export const offlineMiss = (resource: string) =>
  new CliError(
    `No cached data for ${resource}. Run once without --offline to populate the cache.`,
    3,
  );

export const usage = (detail: string) =>
  new CliError(`${detail} Run 'skillwarden --help' for usage.`, 2);
