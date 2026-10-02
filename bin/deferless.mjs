#!/usr/bin/env node
/* deferless now runs ShipProbe.
 *
 * This package keeps the deferless command so that scripts and CI jobs that call it keep working.
 * Each subcommand forwards to the shipprobe CLI this package depends on, and the exit codes are
 * the ones deferless always had:
 *
 *   0  clean
 *   1  the output violates something that was agreed
 *   2  the check could not run. It is not a pass and never collapses into 0.
 *   3  every violation was "this was never produced"
 *
 * deploy-gate is unchanged: the shell library in sh/ still ships with this package.
 */
import path from 'node:path';
import { ROOT, notice, shipprobe, check, promote, render } from '../src/forward.mjs';

const [cmd, ...rest] = process.argv.slice(2);

const HELP = `
deferless now runs ShipProbe: https://shipprobe.thecompound.tech

  deferless check <spec.json> [outputDir]   runs shipprobe plan
  deferless promote [--repo .] [--url ...]  runs shipprobe promote (it reads deferless.json too)
  deferless render <url> [--sample N]       runs shipprobe page
  deferless deploy-gate                     how to wire the shell gate into a deploy script
  deferless init                            runs shipprobe init
  deferless demo                            the plan check against the bundled example

Exit codes:  0 clean · 1 violates the plan · 2 could not run (never a pass) · 3 nothing produced yet

There is no --force, no allowlist and no known-issues file.
`;

notice();

switch (cmd) {
  case 'check':
    process.exit(check(rest));
    break;

  case 'promote':
    process.exit(promote(rest));
    break;

  case 'render':
    process.exit(render(rest));
    break;

  case 'deploy-gate': {
    const lib = path.join(ROOT, 'sh', 'deploy-lock.sh');
    console.log(`The deploy gate is a POSIX shell library, sourced by your deploy script:

  . "${lib}"
  deploy_gate my-app          # defers if other agent sessions are still working, else takes the lock

  DEPLOY_NOW=1 ./scripts/deploy.sh    ship right now regardless of who else is working

It defers rather than queues: a build started while three other sessions are still editing the
tree is stale before it finishes. Deferred repos are registered as pending and ship in one pass
once everything goes quiet. Read the header of the file itself. It explains every knob.

Tests:  bash ${path.join(ROOT, 'test', 'deploy-gate.test.sh')}`);
    process.exit(0);
    break;
  }

  case 'init':
    process.exit(shipprobe(['init', ...rest]));
    break;

  case 'demo': {
    const ex = path.join(ROOT, 'examples', 'api-docs');
    const specPath = path.join(ex, 'plan.spec.json');
    console.log(`\n\x1b[1mThe plan\x1b[0m: ${path.relative(ROOT, path.join(ex, 'PLAN.md'))}, approved before any work started.`);
    console.log('Three endpoint pages, a curl example on each, a schema beside each, no leaked');
    console.log('internal service name, and a declared source commit.\n');

    console.log('\x1b[1m1/2: output that matches the plan\x1b[0m');
    console.log(`\x1b[2m$ deferless check plan.spec.json passing\x1b[0m`);
    const a = check([specPath, path.join(ex, 'passing')]);

    console.log(`\n\x1b[1m2/2: output an agent actually produced\x1b[0m`);
    console.log(`\x1b[2m$ deferless check plan.spec.json failing\x1b[0m`);
    const b = check([specPath, path.join(ex, 'failing')]);

    console.log(`\nBoth trees build. Both render. Nothing in either one errors. The second one`);
    console.log(`silently dropped a page, skipped an example, leaked a name that was renamed`);
    console.log(`before launch, and shipped docs that cannot say which commit made them.`);
    console.log(`\nExit codes: passing=${a}, failing=${b}. There is no flag that turns the second into the first.\n`);
    // The demo is itself a test: if the passing tree ever fails, or the failing tree ever passes,
    // the README is wrong.
    process.exit(a === 0 && b === 1 ? 0 : 2);
    break;
  }

  case '-h': case '--help': case 'help': case undefined:
    console.log(HELP);
    process.exit(cmd === undefined ? 2 : 0);
    break;

  default:
    console.error(`deferless: unknown command "${cmd}"`);
    console.log(HELP);
    process.exit(2);
}
