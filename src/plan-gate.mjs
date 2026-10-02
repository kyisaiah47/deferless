#!/usr/bin/env node
/* Kept so that a deferless.json written by deferless 0.1 still runs: its gates call this file by
 * path. It now forwards to ShipProbe, the same way "deferless check" does, and passes the exit
 * code through unchanged. */
import { notice, check } from './forward.mjs';

notice();
process.exit(check(process.argv.slice(2)));
