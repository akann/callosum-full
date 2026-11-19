// Seeds a few pre-existing keys in terminal states so the page has something to list.
import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { createDb } from '../db.ts';

const sql = createDb();
const rows = [
  { customer: 'cus_8f3a2b71', name: 'Staging', status: 'active', daysAgo: 36, revoked: false },
  { customer: 'cus_8f3a2b71', name: 'Old batch job', status: 'revoked', daysAgo: 50, revoked: true },
  { customer: 'cus_other0001', name: 'Other customer key', status: 'active', daysAgo: 3, revoked: false },
];
for (const r of rows) {
  const secret = 'csk_live_' + randomBytes(24).toString('base64url');
  const created = new Date(Date.now() - r.daysAgo * 86_400_000);
  await sql`
    INSERT INTO api_keys (key_id, customer_id, name, prefix, key_hash, status, created_at, revoked_at)
    VALUES (${'key_' + ulid()}, ${r.customer}, ${r.name}, ${secret.slice(0, 12)},
            ${createHash('sha256').update(secret).digest('hex')}, ${r.status}, ${created},
            ${r.revoked ? new Date() : null})`;
}
console.log(`seeded ${rows.length} keys`);
await sql.end();
