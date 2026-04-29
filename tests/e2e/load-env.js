// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Tiny env-loader for the live-tenant suite (FMN-117).
//
// Reads tests/e2e/.env.local (gitignored) and populates process.env. Two
// formats accepted:
//   1. KEY=VALUE per line (standard .env shape).
//   2. A single bare line treated as the value of FORTIMONITOR_API_KEY.
//
// We do not pull in dotenv-the-package; this is a 30-line need.
// Existing process.env values win over the file (so an explicit
// `FORTIMONITOR_API_KEY=... npm run test:e2e:live` still wins).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_FILE = path.resolve(__dirname, '.env.local');

export function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const text = fs.readFileSync(ENV_FILE, 'utf8').trim();
  if (!text) return;
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));

  // Single-line, no '=': treat as a bare API-key value.
  if (lines.length === 1 && !lines[0].includes('=')) {
    if (!process.env.FORTIMONITOR_API_KEY) {
      process.env.FORTIMONITOR_API_KEY = lines[0].trim();
    }
    return;
  }

  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  }
}
