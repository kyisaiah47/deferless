#!/usr/bin/env node
/* promote-gate — THE GUARD AGAINST "I found it, I reported it, I left it for you".
 *
 *   deferless promote                       # reads deferless.json in the cwd
 *   deferless promote --repo ../my-app      # somewhere else
 *   deferless promote --url http://localhost:3000   # skip the built-in server
 *
 * ── WHAT THIS EXISTS TO STOP ────────────────────────────────────────────────────────────────
 *
 * A coding agent finished a feature and handed its operator two verified findings it had chosen
 * not to act on: a render-gate failure the agent's own deploy script had surfaced, and a defect
 * it had already written the fix for and applied to exactly one of eleven places. Both were
 * described in prose as "deliberately left alone".
 *
 * That is not a judgement call. It is work moved back onto a human: they have to read the
 * finding, decide, and re-issue an instruction that was already obvious.
 *
 * ── WHY PROSE RULES DO NOT HOLD, AND WHAT ACTUALLY DOES ─────────────────────────────────────
 *
 * A rule that says "fix what you find" is checked by the same judgement that just decided not
 * to. So this file does not ask. It removes the STATE that made deferral feel reasonable.
 *
 * The enabling mechanic was ORDERING: the deploy script ran its live checks AFTER the deploy had
 * already landed. By the time a finding appeared the work was live, so "report it" genuinely was
 * the only remaining move — the deferral was baked into the script, not chosen at the end.
 *
 * So the gates run HERE, against a local production server, BEFORE anything is promoted. A
 * finding now blocks the promote instead of annotating it. There is no path where a known
 * failure reaches production and gets written up afterwards.
 *
 * ⛔ THERE IS NO ALLOWLIST, NO --force AND NO "KNOWN ISSUES" FILE, ON PURPOSE. Every one of those
 * is a supported way to record a finding and ship past it, which is the exact behaviour this
 * file exists to make impossible. If a finding is wrong, fix the gate and say why in the commit;
 * if it is right, fix the product. Those are the only two exits.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
const expand = (p) => p.replace(/^~/, os.homedir());
const REPO = path.resolve(expand(val('--repo') || '.'));
const URL_ = val('--url');
const CONFIG_NAME = val('--config') || 'deferless.json';

if (!fs.existsSync(REPO)) {
  console.error(`promote-gate: --repo ${REPO} does not exist.`);
  process.exit(2);
}

/* ── THE CONFIG IS REQUIRED, AND A MISSING ONE IS NOT A PASS ──────────────────────────────────
 * The first version of this file hardcoded one machine's gate paths. That is fine for one
 * machine and useless everywhere else, so the gate list now comes from the repo being promoted.
 * But an absent config still exits non-zero: "there is no config, so nothing was checked, so
 * this is clean" is the same sentence as "the check could not see anything, so it passed". */
const CONFIG_PATH = path.join(REPO, CONFIG_NAME);
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`promote-gate: no ${CONFIG_NAME} in ${REPO}.`);
  console.error('  A repo with no declared gates has not been checked — that is not a pass.');
  console.error('  Run `deferless init` to write one.');
  process.exit(2);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`promote-gate: ${CONFIG_NAME} is not valid JSON — ${e.message}`);
  process.exit(2);
}

const gates = config.gates || [];
if (!gates.length) {
  console.error(`promote-gate: ${CONFIG_NAME} declares no gates. A config that checks nothing is a`);
  console.error('  document, not a gate — write the gates or do not claim the output is gated.');
  process.exit(2);
}

let failed = 0;
const ran = [];

/* Every {url} in a gate's argv is replaced with the base URL under test, so a gate does not need
 * to know how the server was started or on which port it landed. */
function substitute(argv, base) {
  return argv.map((a) => String(a).replace(/\{url\}/g, base).replace(/^~/, os.homedir()));
}

function runGate(g, base) {
  const name = g.name || (Array.isArray(g.run) ? g.run.join(' ') : '(unnamed)');
  if (!Array.isArray(g.run) || !g.run.length) {
    console.error(`  ✗ ${name} — "run" must be a non-empty argv array`);
    failed++;
    return;
  }
  const [cmd, ...rest] = substitute(g.run, base);

  /* ⛔ A MISSING GATE IS A FAILURE, NOT A SKIP. `if [ -f ... ]` around a gate means a moved or
   * renamed check silently stops running and every promote still prints OK — a check that
   * cannot see anything is indistinguishable from a check that found nothing wrong. */
  const localFile = path.isAbsolute(rest[0] || '') ? rest[0] : path.join(REPO, rest[0] || '');
  if ((cmd === 'node' || cmd === 'sh' || cmd === 'bash') && rest[0] && !fs.existsSync(localFile)
      && !fs.existsSync(rest[0])) {
    console.error(`  ✗ ${name} — gate not found at ${rest[0]}`);
    failed++;
    return;
  }

  try {
    execFileSync(cmd, rest, { stdio: 'inherit', cwd: REPO, env: { ...process.env, DEFERLESS_URL: base } });
    console.log(`  ✓ ${name}`);
    ran.push(name);
  } catch {
    console.error(`  ✗ ${name} — findings above. FIX THEM. There is no flag that ships past this.`);
    failed++;
  }
}

/* The server under test is the PRODUCTION build served locally, not a dev server: dev serves
 * unminified CSS with different cascade timing and no prerender, so a finding can appear or
 * vanish between dev and what the host actually serves. */
let server = null;
async function serve() {
  if (URL_) return URL_;
  const s = config.serve;
  if (!s || !s.command) {
    console.error('promote-gate: no `serve.command` in the config and no --url given.');
    console.error('  The gates need something to run against. Declare one or pass --url.');
    process.exit(2);
  }
  const url = s.url || 'http://localhost:3000';
  const [cmd, ...rest] = Array.isArray(s.command) ? s.command : s.command.split(' ');
  server = spawn(cmd, rest, { cwd: REPO, stdio: 'ignore', detached: true });
  const deadline = Date.now() + (s.readyTimeoutMs || 20000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return url;
    } catch { /* not up yet */ }
  }
  throw new Error(`server did not come up on ${url} — is the production build made?`);
}

try {
  const base = await serve();
  console.log(`==> gates against ${base} (BEFORE promote, so a finding blocks rather than annotates)`);
  for (const g of gates) runGate(g, base);
} catch (e) {
  console.error(`promote-gate: ${e.message}`);
  failed++;
} finally {
  if (server?.pid) { try { process.kill(-server.pid); } catch { /* already gone */ } }
}

/* Zero gates run is not a pass. If every gate went missing the honest answer is "I could not
 * check", never "clean". */
if (!failed && !ran.length) {
  console.error('promote-gate: nothing was actually checked. That is not a pass.');
  process.exit(2);
}

console.log(failed
  ? `\n[deferless] ${failed} blocking finding(s). Nothing promotes until they are fixed.`
  : `\n[deferless] ${ran.length} gate(s) clean — safe to promote.`);
process.exit(failed ? 1 : 0);
