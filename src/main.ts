import { parseArgs, type ParseArgsConfig } from 'node:util';
import { runAudit } from './commands/audit.ts';
import { runCheck, type CheckFlags } from './commands/check.ts';
import { runPin, type PinFlags } from './commands/pin.ts';
import { runScan, type ScanFlags } from './commands/scan.ts';
import { CliError, usage } from './output/errors.ts';
import type { CommandContext, GlobalFlags } from './context.ts';
import { VERSION } from './version.ts';

const ROOT_HELP = `skillwarden ${VERSION} — pin, verify, and audit-gate installed agent skills

Usage: skillwarden <command> [options]

Commands:
  scan                     Inventory locally installed skills (offline)
  pin <id>... | --all      Snapshot registry state for installed skills into the lockfile
  check                    Verify integrity, drift, and audit status against the lockfile
  audit <id>               Show security audit report for any registry skill

Global options:
  --json          Machine-readable output on stdout
  --no-color      Disable ANSI color (also: NO_COLOR env, non-TTY)
  --verbose       Progress + rate-limit details on stderr
  --version       Print version
  --help          Print help

Network options (pin, check, audit):
  --offline       Use cached responses only; never touch the network
  --refresh       Ignore cache freshness; refetch everything

Registry access needs SKILLS_SH_API_KEY (a Vercel OIDC token); scan and
check --offline work without it. Run 'skillwarden <command> --help' for details.`;

const COMMAND_HELP: Record<string, string> = {
  scan: `Usage: skillwarden scan [--root <path>]... [--json]

Inventory locally installed skills (directories containing SKILL.md) and
fingerprint their contents. Fully offline.

Options:
  --root <path>   Scan this root instead of the defaults (repeatable)
  --json          Machine-readable output

Default roots: .claude/skills, .agents/skills, skills[/.curated|.experimental|.system]
(project) plus ~/.claude/skills, ~/.cursor/skills, ~/.codex/skills (global).`,
  pin: `Usage: skillwarden pin <id>... [--dir <path>] [options]
       skillwarden pin --all [options]

Snapshot registry state (content digests, hash, security audits) for installed
skills into skillwarden.lock.json. Ids look like 'owner/repo/slug' (GitHub) or
'domain.com/slug' (well-known).

Options:
  --all           Re-pin every skill already in the lockfile
  --dir <path>    Explicit local directory (single id only)
  --offline       Pin from cached registry data only
  --refresh       Refetch even when the cache is fresh
  --json          Machine-readable output`,
  check: `Usage: skillwarden check [--fail-on <cond,...>] [options]

Verify pinned skills on three planes: local integrity (tamper), registry drift,
and security audits. Exit 1 when findings match the --fail-on policy.

Options:
  --fail-on <c,...>  Conditions causing exit 1: tamper, drift, audit-fail,
                     audit-warn, unaudited, duplicate, gone, none
                     (default: tamper,audit-fail)
  --offline          Use cached registry data; unknown planes never fail
  --refresh          Refetch even when the cache is fresh
  --json             Machine-readable output`,
  audit: `Usage: skillwarden audit <id> [--json]

Show the per-partner security audit report for any registry skill (installed or
not). An unaudited skill is a normal data state, reported with exit 0.

Options:
  --offline       Use cached audit data only
  --refresh       Refetch even when the cache is fresh
  --json          Machine-readable output`,
};

const GLOBAL_OPTIONS: ParseArgsConfig['options'] = {
  json: { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  offline: { type: 'boolean', default: false },
  refresh: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

function parseCommandArgs(
  command: string,
  argv: string[],
  extra: ParseArgsConfig['options'] = {},
): { flags: GlobalFlags & Record<string, unknown>; positionals: string[]; help: boolean } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...extra },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    throw usage(`${command}: ${(e as Error).message.split('.')[0]}.`);
  }
  const v = parsed.values as Record<string, unknown>;
  return {
    flags: {
      json: v['json'] === true,
      noColor: v['no-color'] === true,
      verbose: v['verbose'] === true,
      offline: v['offline'] === true,
      refresh: v['refresh'] === true,
      ...v,
    },
    positionals: parsed.positionals,
    help: v['help'] === true,
  };
}

export async function main(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    return await dispatch(argv, ctx);
  } catch (e) {
    if (e instanceof CliError) {
      ctx.stderr(e.message);
      return e.exitCode;
    }
    ctx.stderr(`Unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return 3;
  }
}

async function dispatch(argv: string[], ctx: CommandContext): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h') {
    ctx.stdout(ROOT_HELP);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    ctx.stdout(VERSION);
    return 0;
  }
  const rest = argv.slice(1);

  switch (command) {
    case 'scan': {
      const { flags, positionals, help } = parseCommandArgs(command, rest, {
        root: { type: 'string', multiple: true, default: [] },
      });
      if (help) return printHelp(ctx, 'scan');
      if (positionals.length > 0) throw usage(`scan takes no positional arguments.`);
      if (flags.offline || flags.refresh) {
        throw usage('scan is always offline; --offline/--refresh do not apply.');
      }
      const scanFlags: ScanFlags = { ...flags, roots: flags['root'] as string[] };
      return runScan(scanFlags, ctx);
    }
    case 'pin': {
      const { flags, positionals, help } = parseCommandArgs(command, rest, {
        all: { type: 'boolean', default: false },
        dir: { type: 'string' },
      });
      if (help) return printHelp(ctx, 'pin');
      const pinFlags: PinFlags = {
        ...flags,
        all: flags['all'] === true,
        dir: flags['dir'] as string | undefined,
      };
      return runPin(positionals, pinFlags, ctx);
    }
    case 'check': {
      const { flags, positionals, help } = parseCommandArgs(command, rest, {
        'fail-on': { type: 'string' },
      });
      if (help) return printHelp(ctx, 'check');
      if (positionals.length > 0) throw usage(`check takes no positional arguments.`);
      const checkFlags: CheckFlags = { ...flags, failOn: flags['fail-on'] as string | undefined };
      return runCheck(checkFlags, ctx);
    }
    case 'audit': {
      const { flags, positionals, help } = parseCommandArgs(command, rest, {});
      if (help) return printHelp(ctx, 'audit');
      return runAudit(positionals, flags, ctx);
    }
    default:
      throw usage(`Unknown command '${command}'.`);
  }
}

function printHelp(ctx: CommandContext, command: string): number {
  ctx.stdout(COMMAND_HELP[command]!);
  return 0;
}
