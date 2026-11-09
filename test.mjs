// Smoke test against a LOCAL server (npm run dev) that uses the Ethereal test inbox. Cleans up after itself: npm test
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';

if (process.env.SMTP_HOST) throw new Error('SMTP_HOST is set: the server would send real emails to test addresses, and bounces hurt your sender reputation. Test against a server using the Ethereal inbox.');
const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
if (!/^http:\/\/(localhost|127\.0\.0\.1)\b/.test(BASE)) throw new Error(`Refusing to test ${BASE}: run this against a local server only.`);
const KEY = process.env.STAFF_KEY;

// A real mail domain is needed because the server checks MX records. Ethereal captures everything, so nothing is delivered.
const user = `amassmoke${Date.now()}`;
const email = `${user}@gmail.com`;
const dotted = `${user.slice(0, 4)}.${user.slice(4)}@gmail.com`; // the same inbox to Gmail
const tagged = `${user}+family@googlemail.com`; // also the same inbox

const call = (path, body, headers = {}) =>
  fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) })
    .then(async r => ({ http: r.status, ...(await r.json()) }));
const person = over => ({ name: 'Ada Test', email, phone: '0803 123 4567', ageRange: '21-35', heardFrom: 'WhatsApp', attending: 'yes', transport: 'no', ...over });
const errorKeys = async over => Object.keys((await call('/api/register', person(over))).errors ?? {});

const mongo = await new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017').connect();
const db = mongo.db('amas').collection('registrations');
try {
  let r = await call('/api/register', { name: 'A', email: 'nope', phone: '12', ageRange: '99', heardFrom: { $ne: 1 } });
  assert.equal(r.http, 400);
  assert.deepEqual(Object.keys(r.errors), ['name', 'email', 'phone', 'ageRange', 'heardFrom', 'attending']);
  assert.equal((await call('/api/register', person({ website: 'spam.example' }))).http, 400, 'honeypot');
  for (const bad of ['someone@example.com', 'someone@no-such-domain.test']) // null MX, no such domain
    assert.deepEqual(await errorKeys({ email: bad }), ['email'], `rejects ${bad}`);
  for (const bad of ['0803 123 456', '447700900123', '+234 123 456 7890'])
    assert.deepEqual(await errorKeys({ phone: bad }), ['phone'], `rejects phone ${bad}`);

  r = await call('/api/register', person());
  assert.equal(r.http, 201);
  assert.equal(r.emailed, true, 'ticket email sent');
  assert.match(r.code, /^AMAS-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const { code } = r;
  const ada = await db.findOne({ code });
  assert.deepEqual([ada.phone, ada.inbox], ['+2348031234567', email], 'phone stored as +234…, inbox recorded');

  r = await call('/api/register', person({ name: '  ada   TEST ', email: dotted, phone: '+234 0803 123 4567' }));
  assert.equal(r.status, 'exists', 'same person, even through a Gmail alias');
  assert.equal(r.code, undefined, 'an existing pass is never shown on screen');

  r = await call('/api/register', person({ name: 'Tolu Test', ageRange: '12 & below', email: tagged, phone: '+44 7700 900123' }));
  assert.equal(r.http, 201, 'family member can share the email');
  assert.notEqual(r.code, code);
  assert.equal((await db.findOne({ code: r.code })).phone, '+447700900123', 'foreign numbers keep their country code');

  r = await call('/api/register', person({ name: 'Kemi Test', attending: 'no', phone: '234 803 123 4567' }));
  assert.equal(r.status, 'declined');
  assert.equal(r.code, undefined);
  assert.equal((await call('/api/register', person({ name: 'Kemi Test' }))).http, 201, 'can change their mind');

  const t = await call(`/api/tickets/${code.toLowerCase()}`);
  assert.equal(t.name, 'Ada Test');
  assert.ok(t.qr.startsWith('data:image/png;base64,'));
  assert.equal(t.email ?? t.phone ?? t.inbox, undefined, 'pass page leaks no contact details');

  assert.equal((await call(`/api/tickets/${code}/checkin`, null, { 'x-staff-key': 'wrong' })).http, 401);
  if (KEY) {
    assert.equal((await call(`/api/tickets/${code}/checkin`, null, { 'x-staff-key': KEY })).status, 'checked-in');
    r = await call(`/api/tickets/${code}/checkin`, null, { 'x-staff-key': KEY });
    assert.equal(r.status, 'already', 'a pass works once');
    assert.ok(r.checkedInAt);
    assert.equal((await call('/api/tickets/AMAS-ZZZZ-ZZZZ/checkin', null, { 'x-staff-key': KEY })).http, 404);
  } else console.log('(STAFF_KEY not in env, skipped check-in tests)');

  assert.deepEqual(await errorKeys({ name: 'Ride Test', transport: undefined }), ['transport'], 'attendees must answer the transport question');
  assert.deepEqual(await errorKeys({ name: 'Ride Test', transport: 'yes' }), ['pickup'], 'riders must give a pickup area');
  assert.equal((await call('/api/register', person({ name: 'Ride Test', transport: 'yes', pickup: '  Ikorodu   Garage ' }))).http, 201);
  const ride = await db.findOne({ inbox: email, nameKey: 'ride test' });
  assert.deepEqual([ride.transport, ride.pickup], [true, 'Ikorodu Garage'], 'pickup stored, tidied');

  // Ada, Tolu, Kemi, Ride + 6 guests = 10 passes on one inbox, whichever alias was typed
  for (let i = 0; i < 6; i++) await call('/api/register', person({ name: `Guest ${i} Test`, attending: 'no', email: i % 2 ? dotted : email }));
  assert.equal((await call('/api/register', person({ name: 'One Too Many', email: tagged }))).http, 429, 'Gmail aliases share the per-email cap');

  console.log('✅ all checks passed');
} finally {
  await db.deleteMany({ inbox: email });
  await mongo.close();
}
