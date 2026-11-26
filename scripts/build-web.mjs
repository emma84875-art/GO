// Builds the GO web app with no dependencies, and refuses to finish if the output breaks a security rule.
//
// Why no framework: package installs are blocked in this environment (the npm registry cannot be
// reached), so a framework cannot be installed. This build copies static files and checks them.
//
// Checks (any failure exits with status 1 and writes nothing to dist):
//   1. Every HTML page has a Content-Security-Policy with default-src 'none' and no unsafe script rules.
//   2. No inline script, no inline event handler attributes.
//   3. No secret or service role key material in any file (service_role, sb_secret_, JWT-shaped strings).
//   4. No raw HTML sinks in JavaScript (innerHTML, insertAdjacentHTML, document.write, eval).
//   5. Every JavaScript file parses.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const SOURCE = join(ROOT, 'apps', 'web', 'src');
export const OUTPUT = join(ROOT, 'apps', 'web', 'dist');

const SECRET_PATTERNS = [/service_role/i, /sb_secret_/, /SUPABASE_SERVICE/i, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/];
const RAW_HTML_SINKS = [/\.innerHTML\s*=/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\s*\(/];
// Supplier adapters and their provider endpoints must never reach the browser: they are fixtures or need secrets.
const SUPPLIER_CODE_IN_BROWSER = [/MockFlightSupplier/, /DuffelFlightSupplier/, /api\.duffel\.com/, /DUFFEL_ACCESS_TOKEN/];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

export function checkWebFiles(sourceDir) {
  const problems = [];
  if (!existsSync(sourceDir)) return [`missing source folder: ${sourceDir}`];
  const files = walk(sourceDir);
  const pages = files.filter((f) => f.endsWith('.html'));
  if (pages.length === 0) problems.push('no HTML pages found');

  for (const file of files) {
    const name = relative(sourceDir, file);
    const text = readFileSync(file, 'utf8');

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) problems.push(`${name}: matches a secret pattern (${pattern})`);
    }

    if (file.endsWith('.html')) {
      const csp = text.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/i);
      if (!csp) {
        problems.push(`${name}: no Content-Security-Policy`);
      } else {
        const policy = csp[1];
        if (!/default-src 'none'/.test(policy)) problems.push(`${name}: CSP must start from default-src 'none'`);
        if (/'unsafe-(inline|eval)'/.test(policy)) problems.push(`${name}: CSP allows unsafe inline or eval`);
        if (!/object-src 'none'/.test(policy)) problems.push(`${name}: CSP must set object-src 'none'`);
      }
      for (const tag of text.matchAll(/<script\b[^>]*>/gi)) {
        if (!/\ssrc\s*=/.test(tag[0])) problems.push(`${name}: inline script is not allowed`);
      }
      if (/\son[a-z]+\s*=\s*["']/i.test(text)) problems.push(`${name}: inline event handler attributes are not allowed`);
    }

    if (file.endsWith('.js')) {
      for (const sink of RAW_HTML_SINKS) {
        if (sink.test(text)) problems.push(`${name}: raw HTML or code sink (${sink})`);
      }
      for (const pattern of SUPPLIER_CODE_IN_BROWSER) {
        if (pattern.test(text)) problems.push(`${name}: supplier adapter code must not reach the browser (${pattern})`);
      }
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      } catch (error) {
        problems.push(`${name}: does not parse (${String(error.stderr ?? error.message).split('\n')[0]})`);
      }
    }
  }
  return problems;
}

// The search service's origin is added to connect-src only in the built output, from FLIGHT_SEARCH_ENDPOINT.
// The source file keeps the placeholder, so the source is never tied to a deployed address.
export const SEARCH_PLACEHOLDER = '__FLIGHT_SEARCH_ORIGIN__';

// Returns the origin to allow, or an error. A production build accepts https only and no credentials.
export function searchOriginFor(endpoint) {
  if (endpoint === null || endpoint === undefined) return { origin: '' };
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { error: 'FLIGHT_SEARCH_ENDPOINT is not a valid URL' };
  }
  if (url.protocol !== 'https:') return { error: 'FLIGHT_SEARCH_ENDPOINT must use https in a production build' };
  if (url.username || url.password) return { error: 'FLIGHT_SEARCH_ENDPOINT must not contain credentials' };
  return { origin: url.origin };
}

// connect-src may hold 'self', the Supabase wildcard, the placeholder, and one https origin with no path.
// Anything else (a wildcard, http, a second host) is refused.
export function connectSrcProblems(html) {
  const match = html.match(/connect-src ([^;"]+);/);
  if (!match) return ['the Content-Security-Policy has no connect-src'];
  const problems = [];
  for (const source of match[1].trim().split(/\s+/)) {
    if (source === "'self'" || source === 'https://*.supabase.co' || source === SEARCH_PLACEHOLDER) continue;
    if (/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(source)) continue;
    problems.push(`connect-src contains a source that is not allowed: ${source}`);
  }
  return problems;
}

async function loadEndpoint() {
  const configUrl = pathToFileURL(join(SOURCE, 'config.js')).href;
  const { default: config } = await import(configUrl);
  return config.FLIGHT_SEARCH_ENDPOINT ?? null;
}

export async function build() {
  const problems = checkWebFiles(SOURCE);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`build-web: ${problem}`);
    console.error(`build-web: ${problems.length} problem(s). Nothing written to dist.`);
    return 1;
  }
  const { origin, error } = searchOriginFor(await loadEndpoint());
  if (error) {
    console.error(`build-web: ${error}. Nothing written to dist.`);
    return 1;
  }
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(OUTPUT, { recursive: true });
  cpSync(SOURCE, OUTPUT, { recursive: true });

  const indexPath = join(OUTPUT, 'index.html');
  const html = readFileSync(indexPath, 'utf8').replaceAll(SEARCH_PLACEHOLDER, origin);
  const cspProblems = [...connectSrcProblems(html), ...(html.includes(SEARCH_PLACEHOLDER) ? ['placeholder left in the output'] : [])];
  if (cspProblems.length > 0) {
    for (const problem of cspProblems) console.error(`build-web: ${problem}`);
    rmSync(OUTPUT, { recursive: true, force: true });
    console.error('build-web: Content-Security-Policy check failed. Output removed.');
    return 1;
  }
  writeFileSync(indexPath, html);

  const copied = walk(OUTPUT).length;
  const searchNote = origin ? `search service origin ${origin} allowed in connect-src` : 'no search service origin (flight search not connected)';
  console.log(`build-web: ${copied} files written to ${relative(ROOT, OUTPUT)} with no problems; ${searchNote}.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await build();
}
