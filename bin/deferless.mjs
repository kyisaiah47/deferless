#!/usr/bin/env node
/* deferless — the dispatcher.
 *
 * Every subcommand here is a thin shim onto a gate in src/. The gates are the product; this
 * file exists so that `npx deferless demo` is the first thing a stranger can run, and so that
 * the exit codes are uniform across all of them:
 *
 *   0  clean
 *   1  the output violates something that was agreed
 *   2  the gate could not run — which is NOT a pass, and never collapses into 0
 *   3  every violation was "this was never produced" (plan-gate only; see docs/SPEC.md)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = (f) => path.join(ROOT, 'src', f);

const [cmd, ...rest] = process.argv.slice(2);

const run = (file, args, opts = {}) =>
  spawnSync(process.execPath, [SRC(file), ...args], { stdio: 'inherit', ...opts }).status ?? 2;

const HELP = `
deferless — fail-closed gates for work an agent did on your behalf.

  deferless check <spec.json> [outputDir]   the output must match the approved plan
  deferless promote [--repo .] [--url ...]  run every declared gate BEFORE anything ships
  deferless render <url> [--sample N]       open the page in a real browser and measure it
  deferless deploy-gate                     how to wire the shell gate into a deploy script
  deferless init                            write a starter deferless.json + spec
  deferless demo                            run a real gate against the bundled example

Exit codes:  0 clean · 1 violates the plan · 2 could not run (never a pass) · 3 nothing produced yet

There is no --force, no allowlist and no known-issues file. That is the whole point;
see docs/PRINCIPLES.md.
`;

switch (cmd) {
  case 'check':
    if (!rest.length) { console.error('usage: deferless check <spec.json> [outputDir]'); process.exit(2); }
    process.exit(run('plan-gate.mjs', rest));
    break;

  case 'promote':
    process.exit(run('promote-gate.mjs', rest));
    break;

  case 'render':
    if (!rest.length) { console.error('usage: deferless render <url> [--sample N] [--json] [--shots dir]'); process.exit(2); }
    process.exit(run('render-gate.mjs', rest));
    break;

  case 'deploy-gate': {
    const lib = path.join(ROOT, 'sh', 'deploy-lock.sh');
    console.log(`The deploy gate is a POSIX shell library, sourced by your deploy script:

  . "${lib}"
  deploy_gate my-app          # defers if other agent sessions are still working, else takes the lock

  DEPLOY_NOW=1 ./scripts/deploy.sh    ship right now regardless of who else is working

It defers rather than queues: a build started while three other sessions are still editing the
tree is stale before it finishes. Deferred repos are registered as pending and ship in one pass
once everything goes quiet. Read the header of the file itself — it explains every knob.

Tests:  bash ${path.join(ROOT, 'test', 'deploy-gate.test.sh')}`);
    process.exit(0);
    break;
  }

  case 'init': {
    const target = process.cwd();
    const cfg = path.join(target, 'deferless.json');
    const spec = path.join(target, 'plan.spec.json');
    if (fs.existsSync(cfg)) { console.error(`deferless: ${cfg} already exists — not overwriting it.`); process.exit(2); }
    fs.writeFileSync(cfg, JSON.stringify({
      serve: { command: 'npm run start', url: 'http://localhost:3000', readyTimeoutMs: 20000 },
      gates: [
        { name: 'plan gate', run: ['node', path.relative(target, SRC('plan-gate.mjs')), 'plan.spec.json', '.'] },
        { name: 'render gate', run: ['node', path.relative(target, SRC('render-gate.mjs')), '{url}'] },
      ],
    }, null, 2) + '\n');
    if (!fs.existsSync(spec)) {
      fs.writeFileSync(spec, JSON.stringify({
        source: 'docs/plans/YOUR-PLAN.md',
        checks: [{
          kind: 'files', glob: 'dist/*.js', min: 1,
          quote: 'paste the sentence from the plan that this check enforces',
        }],
      }, null, 2) + '\n');
    }
    console.log(`wrote ${path.relative(target, cfg)} and ${path.relative(target, spec)}

Next: replace the placeholder check with one per binding sentence in your plan, and put the real
sentence in "quote" — the quote is what gets printed when the check fails, so the violation is
reported in the plan's words and not the gate's.`);
    process.exit(0);
    break;
  }

  case 'demo': {
    const ex = path.join(ROOT, 'examples', 'api-docs');
    const specPath = path.join(ex, 'plan.spec.json');
    console.log(`\n\x1b[1mThe plan\x1b[0m — ${path.relative(ROOT, path.join(ex, 'PLAN.md'))}, approved before any work started.`);
    console.log('Three endpoint pages, a curl example on each, a schema beside each, no leaked');
    console.log('internal service name, and a declared source commit.\n');

    console.log('\x1b[1m1/2 — output that matches the plan\x1b[0m');
    console.log(`\x1b[2m$ deferless check plan.spec.json passing\x1b[0m`);
    const a = run('plan-gate.mjs', [specPath, path.join(ex, 'passing')]);

    console.log(`\n\x1b[1m2/2 — output an agent actually produced\x1b[0m`);
    console.log(`\x1b[2m$ deferless check plan.spec.json failing\x1b[0m`);
    const b = run('plan-gate.mjs', [specPath, path.join(ex, 'failing')]);

    console.log(`\nBoth trees build. Both render. Nothing in either one errors. The second one`);
    console.log(`silently dropped a page, skipped an example, leaked a name that was renamed`);
    console.log(`before launch, and shipped docs that cannot say which commit made them.`);
    console.log(`\nExit codes: passing=${a}, failing=${b}. There is no flag that turns the second into the first.\n`);
    // The demo is itself a test: if the passing tree ever fails, or the failing tree ever passes,
    // this repo is lying in its own README.
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
