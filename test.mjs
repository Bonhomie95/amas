// Smoke test against the running server (npm run dev), then cleans up after itself: npm test
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';

if (process.env.SMTP_HOST) throw new Error('SMTP_HOST is set: the server would send real emails to fake test addresses, and the bounces hurt your sender reputation. Test against a server using the Ethereal inbox.');
const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const KEY = process.env.STAFF_KEY;
const email = `test-${Date.now()}@example.test`;
const call = (path, body, headers = {}) =>
  fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) })
    .then(async r => ({ http: r.status, ...(await r.json()) }));
const person = over => ({ name: 'Ada Test', email, phone: '0803 123 4567', ageRange: '21-35', heardFrom: 'WhatsApp', attending: 'yes', ...over });

const mongo = await new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017').connect();
try {
  let r = await call('/api/register', { name: 'A', email: 'nope', phone: '12', ageRange: '99', heardFrom: { $ne: 1 } });
  assert.equal(r.http, 400);
  assert.deepEqual(Object.keys(r.errors), ['name', 'email', 'phone', 'ageRange', 'heardFrom', 'attending']);
  assert.equal((await call('/api/register', person({ website: 'spam.example' }))).http, 400, 'honeypot');

  r = await call('/api/register', person());
  assert.equal(r.http, 201);
  assert.equal(r.emailed, true, 'ticket email sent');
  assert.match(r.code, /^AMAS-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const { code } = r;

  r = await call('/api/register', person({ name: '  ada   TEST ' }));
  assert.equal(r.status, 'exists', 'same person is recognised');
  assert.equal(r.code, undefined, 'an existing pass is never shown on screen');

  r = await call('/api/register', person({ name: 'Tolu Test', ageRange: '12 & below' }));
  assert.equal(r.http, 201, 'family member can share the email');
  assert.notEqual(r.code, code);

  r = await call('/api/register', person({ name: 'Kemi Test', attending: 'no' }));
  assert.equal(r.status, 'declined');
  assert.equal(r.code, undefined);
  assert.equal((await call('/api/register', person({ name: 'Kemi Test' }))).http, 201, 'can change their mind');

  const t = await call(`/api/tickets/${code.toLowerCase()}`);
  assert.equal(t.name, 'Ada Test');
  assert.ok(t.qr.startsWith('data:image/png;base64,'));
  assert.equal(t.email ?? t.phone, undefined, 'pass page leaks no contact details');

  assert.equal((await call(`/api/tickets/${code}/checkin`, null, { 'x-staff-key': 'wrong' })).http, 401);
  if (KEY) {
    assert.equal((await call(`/api/tickets/${code}/checkin`, null, { 'x-staff-key': KEY })).status, 'checked-in');
    r = await call(`/api/tickets/${code}/checkin`, null, { 'x-staff-key': KEY });
    assert.equal(r.status, 'already', 'a pass works once');
    assert.ok(r.checkedInAt);
    assert.equal((await call('/api/tickets/AMAS-ZZZZ-ZZZZ/checkin', null, { 'x-staff-key': KEY })).http, 404);
  } else console.log('(STAFF_KEY not in env, skipped check-in tests)');

  for (let i = 0; i < 7; i++) await call('/api/register', person({ name: `Guest ${i} Test`, attending: 'no' }));
  assert.equal((await call('/api/register', person({ name: 'One Too Many' }))).http, 429, 'per-email cap');

  console.log('✅ all checks passed');
} finally {
  await mongo.db('amas').collection('registrations').deleteMany({ email: /@example\.test$/ });
  await mongo.close();
}
