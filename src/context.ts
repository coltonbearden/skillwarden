import os from 'node:os';
import { openCache } from './api/cache.ts';
import { createClient, DEFAULT_BASE_URL, type Client, type ClientMode } from './api/client.ts';
import { colorEnabled, colorizer, type Colors } from './output/format.ts';
import { cacheDir } from './util/paths.ts';

export interface CommandContext {
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  isTTY: boolean;
}

export interface GlobalFlags {
  json: boolean;
  noColor: boolean;
  verbose: boolean;
  offline: boolean;
  refresh: boolean;
}

export function realContext(): CommandContext {
  return {
    cwd: process.cwd(),
    home: os.homedir(),
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    fetchImpl: fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    isTTY: process.stdout.isTTY === true,
  };
}

export function colorsFor(ctx: CommandContext, flags: GlobalFlags): Colors {
  return colorizer(colorEnabled(flags.noColor || flags.json, ctx.env, ctx.isTTY));
}

export function buildClient(ctx: CommandContext, flags: GlobalFlags): Client {
  const mode: ClientMode = flags.offline ? 'offline' : flags.refresh ? 'refresh' : 'online';
  const token = ctx.env['SKILLS_SH_API_KEY'];
  return createClient({
    baseUrl: ctx.env['SKILLWARDEN_API_BASE'] ?? DEFAULT_BASE_URL,
    token: token !== undefined && token !== '' ? token : undefined,
    cache: openCache(cacheDir(ctx.env, os.platform(), ctx.home), ctx.stderr),
    fetchImpl: ctx.fetchImpl,
    sleep: ctx.sleep,
    now: ctx.now,
    mode,
    verbose: flags.verbose,
    stderr: ctx.stderr,
  });
}

export function hasToken(ctx: CommandContext): boolean {
  const t = ctx.env['SKILLS_SH_API_KEY'];
  return t !== undefined && t !== '';
}
