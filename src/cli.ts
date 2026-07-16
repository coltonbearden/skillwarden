#!/usr/bin/env node
import { main } from './main.ts';
import { realContext } from './context.ts';

process.exitCode = await main(process.argv.slice(2), realContext());
