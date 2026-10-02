/* deferless now runs ShipProbe.
 *
 * Every command in this package forwards to the shipprobe CLI it depends on. The exit code comes
 * back unchanged, so the codes mean what they meant in deferless 0.1:
 *
 *   0  clean
 *   1  the output violates something that was agreed
 *   2  the check could not run. It is not a pass and never collapses into 0.
 *   3  every violation was "this was never produced"
 *
 * A missing shipprobe install is exit 2, because nothing was checked.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function shipprobeBin() {
  try {
    return path.join(path.dirname(require.resolve('shipprobe/package.json')), 'bin', 'shipprobe.mjs');
  } catch {
    return null;
  }
}

/* One notice line per run. A gate that promote starts inherits the variable, so a promote that
 * runs deferless gates still prints the line once. It goes to stderr, so --json output on stdout
 * stays parseable. */
const SHOWN = 'DEFERLESS_NOTICE_SHOWN';
export function notice() {
  if (process.env[SHOWN]) return;
  process.env[SHOWN] = '1';
  process.stderr.write(
    `deferless ${VERSION} now runs ShipProbe. check is "shipprobe plan", promote is "shipprobe promote" and render is "shipprobe page": https://shipprobe.thecompound.tech/plan\n`,
  );
}

export function shipprobe(args) {
  const bin = shipprobeBin();
  if (!bin || !fs.existsSync(bin)) {
    process.stderr.write('deferless: the shipprobe package is not installed, so nothing was checked. Run npm install.\n');
    return 2;
  }
  const r = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit', env: process.env });
  return r.status ?? 2;
}

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/* shipprobe flags that take a value, so their value is not read as a positional argument. */
const VALUE_FLAGS = new Set(['--provider', '--model', '--base-url', '--fix-out', '--repo', '--sample', '--shots']);
function split(args) {
  const pos = [];
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      flags.push(a);
      if (VALUE_FLAGS.has(a) && i + 1 < args.length) flags.push(args[++i]);
    } else pos.push(a);
  }
  return { pos, flags };
}

/* deferless check <spec.json> [outputDir]. The output directory was optional in deferless and
 * shipprobe plan requires it, so it is resolved here the way plan-gate resolved it: the argument,
 * else the spec's own outputDir, else the working directory. */
export function check(args) {
  const { pos, flags } = split(args);
  const [spec, outArg] = pos;
  if (!spec) {
    process.stderr.write('usage: deferless check <spec.json> [outputDir]\n');
    return 2;
  }
  let fromSpec = null;
  try {
    fromSpec = JSON.parse(fs.readFileSync(expand(spec), 'utf8')).outputDir || null;
  } catch {
    /* An unreadable spec is reported by shipprobe plan, which exits 2 on it. */
  }
  const dir = path.resolve(expand(outArg || fromSpec || '.'));
  return shipprobe(['plan', expand(spec), dir, ...flags]);
}

export function promote(args) {
  return shipprobe(['promote', ...args]);
}

/* deferless render <url> [--sample N] [--shots dir] [--json] [--quiet] [--all]. --all only changed
 * how many findings were printed, and shipprobe page prints every finding, so it is dropped.
 * --shots goes to shipprobe page unchanged. It saves <width>.png at each rendered width of 1280px
 * or more; deferless 0.1 also saved the phone and tablet widths. Its value is skipped by split(),
 * so `--shots out/` is never read as a URL. */
export function render(args) {
  const kept = args.filter((a) => a !== '--all');
  const { pos } = split(kept);
  if (!pos.length) {
    process.stderr.write('usage: deferless render <url> [<url> ...] [--sample N] [--shots dir] [--json] [--quiet]\n');
    return 2;
  }
  return shipprobe(['page', ...kept]);
}
