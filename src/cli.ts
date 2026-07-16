#!/usr/bin/env node
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

Run 'skillwarden <command> --help' for command-specific options.`;

export function mainStub(argv: string[]): number {
  const first = argv[0];
  if (first === '--version' || first === '-v') {
    console.log(VERSION);
    return 0;
  }
  if (first === undefined || first === '--help' || first === '-h') {
    console.log(ROOT_HELP);
    return 0;
  }
  console.error(`Unknown command '${first}'. Run 'skillwarden --help' for usage.`);
  return 2;
}

process.exitCode = mainStub(process.argv.slice(2));
