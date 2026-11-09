import express from 'express';
import { MongoClient } from 'mongodb';
import QRCode from 'qrcode';
import nodemailer from 'nodemailer';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const env = process.env;
const PORT = env.PORT || 3000;
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, ''); // never from the Host header: it ends up in emails
const STAFF_KEY = env.STAFF_KEY || randomBytes(6).toString('base64url');
const PUBLIC = join(import.meta.dirname, 'public');

// Keep in sync with the chips in public/index.html
const AGE_RANGES = ['12 & below', '13-20', '21-35', '36-50', '51 & above'];
const SOURCES = ['WhatsApp', 'Instagram', 'Facebook', 'TikTok', 'YouTube', 'X (Twitter)', 'Friend or family', 'Church', 'Flyer or poster', 'Radio or TV', 'Other'];
const MAX_PER_EMAIL = 10; // families may share one email; also caps how hard anyone can spam an inbox through us

const EVENT = {
  title: 'A Night of Praise & Worship 2.0',
  theme: 'Covenant Keeping God',
  when: 'Friday, December 11, 2026 · 7:00 PM',
  venue: 'Regal Hall, Daystar Christian Centre',
  address: 'Plot A3C, Ikosi Road, Oregun, Lagos',
};
const CAL_URL = 'https://calendar.google.com/calendar/render?' + new URLSearchParams({
  action: 'TEMPLATE', text: EVENT.title, dates: '20261211T180000Z/20261211T220000Z', // 7–11 PM WAT
  location: `${EVENT.venue}, ${EVENT.address}`, details: `Theme: ${EVENT.theme} (Deut. 7:9). Bring your QR pass. Entry is free.`,
});
const MAP_URL = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Daystar Christian Centre, Ikosi Road, Oregun, Lagos');

const mongo = await new MongoClient(env.MONGODB_URI || 'mongodb://127.0.0.1:27017').connect();
const regs = mongo.db('amas').collection('registrations');
await regs.createIndex({ email: 1, nameKey: 1 }, { unique: true });
await regs.createIndex({ code: 1 }, { unique: true });

// ---------- helpers ----------
const line = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, easy to read out at the door
const newCode = () => 'AMAS-' + Array.from({ length: 8 }, (_, i) => (i === 4 ? '-' : '') + ABC[randomInt(ABC.length)]).join('');
const passUrl = code => `${BASE_URL}/t/${code}`;
const QR = { width: 600, margin: 2, color: { dark: '#06343B', light: '#FFFFFF' } };
const sha = s => createHash('sha256').update(String(s)).digest();
const isStaff = key => !!key && timingSafeEqual(sha(key), sha(STAFF_KEY));
const PUBLIC_FIELDS = { projection: { _id: 0, name: 1, code: 1, ageRange: 1, checkedInAt: 1 } };

let transport;
const mailer = () => (transport ??= (env.SMTP_HOST
  ? Promise.resolve(nodemailer.createTransport({
      host: env.SMTP_HOST, port: +(env.SMTP_PORT || 587), secure: String(env.SMTP_PORT).endsWith('465'), // 465/2465 = implicit TLS
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, connectionTimeout: 10_000, socketTimeout: 20_000,
    }))
  : nodemailer.createTestAccount().then(a => {
      console.log(`📭 No SMTP set, so emails go to a test inbox at https://ethereal.email (login ${a.user} / ${a.pass})`);
      return nodemailer.createTransport({ ...a.smtp, auth: { user: a.user, pass: a.pass } });
    })
).catch(e => { transport = undefined; throw e; }));

async function sendTicket(doc) {
  const url = passUrl(doc.code);
  try {
    const info = await (await mailer()).sendMail({
      from: env.MAIL_FROM || `"AMAS Foundation" <${env.SMTP_USER || 'tickets@ethereal.email'}>`,
      to: doc.email,
      subject: `Your pass for ${EVENT.title} 🎟️`,
      html: ticketHtml(doc, url),
      text: ticketText(doc, url),
      attachments: [
        { filename: 'amas-logo.png', path: join(PUBLIC, 'img/logo.png'), cid: 'logo' },
        { filename: `${doc.code}.png`, content: await QRCode.toBuffer(url, QR), cid: 'qr' },
      ],
    });
    await regs.updateOne({ _id: doc._id }, { $set: { emailedAt: new Date() }, $unset: { emailError: 1 } });
    const preview = nodemailer.getTestMessageUrl(info) || undefined;
    if (preview) console.log(`📧 ${doc.email} → ${preview}`);
    return { emailed: true, preview };
  } catch (e) {
    console.error(`✉️  Email to ${doc.email} failed:`, e.message);
    await regs.updateOne({ _id: doc._id }, { $set: { emailError: e.message } });
    return { emailed: false };
  }
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

app.get('/', async (req, res) => res.type('html').send((await readFile(join(PUBLIC, 'index.html'), 'utf8')).replaceAll('%BASE_URL%', BASE_URL)));
app.get('/t/:code', (req, res) => res.sendFile(join(PUBLIC, 'ticket.html')));
app.use(express.static(PUBLIC, { index: false }));

app.post('/api/register', async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.status(400).json({ error: 'Could not submit the form.' }); // honeypot field, invisible to humans
  const r = {
    name: line(b.name, 80),
    email: line(b.email, 254).toLowerCase(),
    phone: line(b.phone, 24).replace(/[\s().-]/g, ''),
    ageRange: b.ageRange,
    heardFrom: b.heardFrom,
    heardFromOther: b.heardFrom === 'Other' ? line(b.heardFromOther, 80) : '',
    attending: b.attending === 'yes' ? true : b.attending === 'no' ? false : null,
    church: line(b.church, 100),
    assistance: text(b.assistance, 300),
    prayer: text(b.prayer, 1000),
    updates: b.updates === 'on',
  };
  const errors = {};
  if (r.name.length < 2) errors.name = 'Please enter your full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(r.email)) errors.email = 'Please enter a valid email address.';
  if (!/^\+?\d{7,15}$/.test(r.phone)) errors.phone = 'Please enter a valid phone number.';
  if (!AGE_RANGES.includes(r.ageRange)) errors.ageRange = 'Please pick your age range.';
  if (!SOURCES.includes(r.heardFrom)) errors.heardFrom = 'Please tell us how you heard about the program.';
  if (r.attending === null) errors.attending = 'Please let us know if you’ll be attending.';
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const key = { email: r.email, nameKey: r.name.toLowerCase() };
  const existing = await regs.findOne(key);
  if (existing?.attending) {
    // Never show an existing pass on screen (anyone could type your email); re-send it to the inbox instead.
    const recent = Date.now() - (existing.emailedAt ?? 0) < 60_000;
    return res.status(409).json({ status: 'exists', ...(recent ? { emailed: true } : await sendTicket(existing)) });
  }
  if (!existing && (await regs.countDocuments({ email: r.email })) >= MAX_PER_EMAIL)
    return res.status(429).json({ error: `This email already has ${MAX_PER_EMAIL} passes. Please use a different email for more guests.` });

  const doc = await regs.findOneAndUpdate(
    key,
    { $set: { ...r, updatedAt: new Date() }, $setOnInsert: { code: newCode(), createdAt: new Date(), checkedInAt: null } },
    { upsert: true, returnDocument: 'after' },
  );
  if (!doc.attending) return res.json({ status: 'declined' });
  res.status(201).json({ status: 'registered', code: doc.code, ...(await sendTicket(doc)) });
});

app.get('/api/tickets/:code', async (req, res) => {
  const t = await regs.findOne({ code: req.params.code.toUpperCase(), attending: true }, PUBLIC_FIELDS);
  if (!t) return res.status(404).json({ error: 'We couldn’t find this pass.' });
  res.json({ ...t, qr: await QRCode.toDataURL(passUrl(t.code), QR) });
});

// Staff scan a pass → this marks it used, once. A second scan reports when it was first used.
app.post('/api/tickets/:code/checkin', async (req, res) => {
  if (!isStaff(req.get('x-staff-key'))) return res.status(401).json({ error: 'Wrong staff key.' });
  const code = req.params.code.toUpperCase();
  const t = await regs.findOneAndUpdate(
    { code, attending: true, checkedInAt: null },
    { $set: { checkedInAt: new Date() } },
    { ...PUBLIC_FIELDS, returnDocument: 'after' },
  );
  if (t) return res.json({ status: 'checked-in', ...t });
  const prev = await regs.findOne({ code, attending: true }, PUBLIC_FIELDS);
  if (!prev) return res.status(404).json({ status: 'invalid', error: 'No pass with this code.' });
  res.status(409).json({ status: 'already', ...prev });
});

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? 'Invalid request.' : 'Something went wrong. Please try again.' });
});

app.listen(PORT, err => {
  if (err) throw err;
  console.log(`🎶 Registration open at ${BASE_URL}`);
  if (!env.STAFF_KEY) console.log(`🔑 STAFF_KEY not set, so this run's staff key is: ${STAFF_KEY}`);
});

// ---------- email ----------
function ticketHtml(d, url) {
  const first = esc(d.name.split(' ')[0]);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#04363D;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#04363D;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:22px;overflow:hidden">
  <tr><td style="height:6px;background:#FFB300;font-size:0;line-height:0">&nbsp;</td></tr>
  <tr><td align="center" style="padding:28px 24px 6px"><img src="cid:logo" width="230" alt="AMAS Foundation" style="display:block;width:230px;max-width:80%;height:auto;border:0"></td></tr>
  <tr><td align="center" style="padding:10px 28px 0;color:#0B2A30">
    <p style="margin:0;font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#B97F00;font-weight:bold">You’re in, ${first}!</p>
    <h1 style="margin:10px 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:27px;line-height:1.2;color:#04363D">${esc(EVENT.title)}</h1>
    <p style="margin:0;font-size:15px;color:#5B7479">Theme: <b style="color:#028F99">${esc(EVENT.theme)}</b> · Deut. 7:9</p>
  </td></tr>
  <tr><td align="center" style="padding:24px 24px 20px">
    <table role="presentation" cellpadding="0" cellspacing="0" style="border:2px dashed #FFB300;border-radius:18px"><tr><td align="center" style="padding:16px 18px">
      <img src="cid:qr" width="220" height="220" alt="QR pass ${esc(d.code)}" style="display:block;border:0">
      <p style="margin:10px 0 0;font-family:'Courier New',monospace;font-size:18px;font-weight:bold;letter-spacing:2px;color:#04363D">${esc(d.code)}</p>
      <p style="margin:4px 0 0;font-size:12px;color:#5B7479">ADMIT ONE · ${esc(d.name)}</p>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:0 28px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF8F8;border-radius:14px"><tr><td style="padding:16px 18px;font-size:15px;line-height:1.7;color:#0B2A30">
      📅 <b>${esc(EVENT.when)}</b><br>📍 <b>${esc(EVENT.venue)}</b><br><span style="color:#5B7479;padding-left:24px">${esc(EVENT.address)}</span>
    </td></tr></table>
  </td></tr>
  <tr><td align="center" style="padding:22px 28px 6px">
    <a href="${esc(url)}" style="display:inline-block;background:#FFB300;color:#04363D;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 26px;border-radius:999px">View my pass</a>
  </td></tr>
  <tr><td align="center" style="padding:8px 28px 24px;font-size:14px">
    <a href="${esc(CAL_URL)}" style="color:#028F99">Add to calendar</a> &nbsp;·&nbsp; <a href="${esc(MAP_URL)}" style="color:#028F99">Get directions</a>
  </td></tr>
  <tr><td style="padding:18px 28px;background:#FFF6DD;font-size:13px;line-height:1.6;color:#5B4A1F">
    Show this QR code at the entrance, on your phone or printed. Each pass admits <b>one person</b>, so every guest needs their own. Entry is free.
  </td></tr>
</table>
<p style="margin:18px 0 0;font-size:12px;color:#8FC3C6">AMAS Foundation · Impacting life since 2009</p>
</td></tr></table></body></html>`;
}

const ticketText = (d, url) => `You're in, ${d.name}!

${EVENT.title}
Theme: ${EVENT.theme} (Deut. 7:9)
${EVENT.when}
${EVENT.venue}, ${EVENT.address}

Your pass: ${d.code}
Show your QR pass: ${url}
Add to calendar: ${CAL_URL}
Directions: ${MAP_URL}

Show your QR code at the entrance. Each pass admits one person. Entry is free.
AMAS Foundation`;
