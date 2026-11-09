# N.O.P.A.W 2.0 registration · AMAS Foundation

Free registration for **A Night of Praise & Worship 2.0**: Friday, December 11, 2026, 7:00 PM, Regal Hall, Daystar Christian Centre, Oregun, Lagos.
People register, get a QR pass by email, and door staff scan it at the entrance.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # smoke test, with the server running (cleans up after itself)
```

You need Node 22 or newer and MongoDB on `127.0.0.1:27017`. Settings live in `.env` (copy `.env.example`).

With no SMTP settings, every email goes to a free [Ethereal](https://ethereal.email) test inbox and is never really delivered.
The terminal prints a preview link for each email, and the pass page shows an "Open the email that was sent" link.

| URL | What it is |
| --- | --- |
| `/` | Registration page |
| `/t/<code>` | A person's pass. The QR code points here. |
| `/nopaw.ics` | Calendar invite |

## At the door

1. On each staff phone, open the site, tap **Staff check-in** at the bottom of any pass page and enter the `STAFF_KEY`. You only do this once per phone.
2. Scan the attendee's QR with the phone camera. The pass opens full screen:
   - green **Welcome in!**
   - amber **Already used**, with the time it was first scanned
   - red **Not a valid pass**
3. If the attendee's phone is dead, type the code printed under their QR: `<your-site>/t/AMAS-XXXX-XXXX`.

## Going live

1. **Database**: set `MONGODB_URI` to your Atlas connection string. The `amas` database and its indexes are created on start.
2. **Email**: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`. Gmail with an app password covers about 500 emails a day. For bigger volumes, use the SMTP settings from Brevo, Resend, SendGrid or Mailgun.
3. **`BASE_URL`**: set this to the public address, e.g. `https://register.amasfoundation.org`. Every QR code and email link contains it, so set it **before** you share the link.
4. **`STAFF_KEY`**: use a long passphrase.
5. Deploy to anything that runs Node (Render, Railway, Fly, a VPS) with `npm install && npm start`.

## How registration behaves

- Every person gets their own pass. Family members can share one email address (up to 10 passes per email).
- If someone registers again with the same name and email, the pass is re-sent to that inbox rather than shown on screen. That way nobody can pull up another person's pass just by typing their email.
- "No, I can't make it" answers are saved without a pass. If that person registers again with "Yes", they get one.
- Bots are filtered with a hidden honeypot field. If the form gets abused, add a CAPTCHA (Cloudflare Turnstile is free).

## The data

Everything is in `amas.registrations`, one document per person:
`name, email, phone, ageRange, heardFrom, heardFromOther, attending, church, assistance, prayer, updates, code, createdAt, emailedAt, emailError, checkedInAt`.

- Browse or export it with MongoDB Compass (Export → CSV), or from the command line:

  ```bash
  mongoexport --uri "mongodb://127.0.0.1:27017/amas" --collection registrations --type csv --out registrations.csv --fields name,email,phone,ageRange,heardFrom,heardFromOther,attending,church,assistance,prayer,updates,code,createdAt,checkedInAt
  ```

- To find people whose email failed, filter on `{ "emailError": { "$exists": true } }`.

## Changing event details

The event details appear in four places: `EVENT` in `server.js` (the email), `public/index.html`, `public/ticket.html` and `public/nopaw.ics`.
The age ranges and "how did you hear" options are defined in both `server.js` and `public/index.html`, so keep the two lists in sync.
