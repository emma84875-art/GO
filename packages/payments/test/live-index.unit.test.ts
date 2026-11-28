// Regression: the database's one-live-payment index must cover exactly the application's live statuses. The test reads
// the most recent definition of the index from the migrations, so a future migration that drifts from LIVE_STATUSES fails
// here before it reaches the database checks.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_STATUSES } from '../src/state.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
const INDEX_DEFINITION = /create\s+unique\s+index\s+payments_one_live_per_booking\s+on\s+public\.payments\s*\(\s*booking_id\s*\)\s*where\s+status\s+in\s*\(([^)]*)\)/gi;

// The status list in the most recent migration that defines the index, in the order the migrations apply.
function liveIndexStatuses(): readonly string[] {
  let latest: string[] | null = null;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    for (const match of readFileSync(MIGRATIONS + file, 'utf8').matchAll(INDEX_DEFINITION)) {
      latest = [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    }
  }
  assert.ok(latest, 'no migration defines payments_one_live_per_booking');
  return latest;
}

test('the live-payment index covers exactly LIVE_STATUSES', () => {
  assert.deepEqual([...liveIndexStatuses()].sort(), [...LIVE_STATUSES].sort());
});

test('the live-payment index includes capture_requested', () => {
  assert.ok(liveIndexStatuses().includes('capture_requested'));
});
