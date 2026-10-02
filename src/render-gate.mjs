#!/usr/bin/env node
/* Kept so that a deferless.json written by deferless 0.1 still runs: its gates call this file by
 * path. It now forwards to ShipProbe, the same way "deferless render" does, and passes the exit
 * code through unchanged. */
import { notice, render } from './forward.mjs';

notice();
process.exit(render(process.argv.slice(2)));
