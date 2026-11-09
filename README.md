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

## Live on Vercel

Production: **https://amas-nopaw.vercel.app**. The Vercel project `amas-nopaw` deploys `main` from `Bonhomie95/amas` on every push.

- The pages in `public/` are served from Vercel's CDN, and `vercel.json` maps `/` and `/t/<code>` to them. Only `/api/*` runs the Express function, in Frankfurt (`fra1`).
- Settings live in Vercel → Project → Settings → Environment Variables. After changing any of them, redeploy, because a running deployment keeps its old values.

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Atlas connection string. Allow `0.0.0.0/0` under Network Access, since Vercel has no fixed IP addresses. |
| `SMTP_HOST`, `SMTP_PORT` | The AWS SES Mail Manager ingress endpoint, `587` (already set) |
| `SMTP_USER`, `SMTP_PASS` | The ingress point ID (`inp-…`) and its password |
| `MAIL_FROM`, `MAIL_FROM_NAME` | `alerts@envelock.org`, `AMAS Foundation` (already set). AWS must be allowed to send from that address. |
| `STAFF_KEY` | A long passphrase for door staff |
| `BASE_URL` | Optional. It defaults to the production domain, so only set it if you add a custom domain. |

In production the server refuses to start without `MONGODB_URI`, and it never falls back to the test inbox, so a missing email setting shows up as an error rather than lost emails.

## How registration behaves

- Every person gets their own pass. Family members can share one email address (up to 10 passes per email).
- If someone registers again with the same name and email, the pass is re-sent to that inbox rather than shown on screen. That way nobody can pull up another person's pass just by typing their email.
- Attendees are asked whether they need free transport from anywhere in Lagos. Riders give their area or nearest bus stop, and their pass email confirms the booking.
- "No, I can't make it" answers are saved without a pass. If that person registers again with "Yes", they get one.
- Bots are filtered with a hidden honeypot field. If the form gets abused, add a CAPTCHA (Cloudflare Turnstile is free).

## The data

Everything is in `amas.registrations`, one document per person:
`name, email, phone, ageRange, heardFrom, heardFromOther, attending, transport, pickup, church, assistance, prayer, updates, code, createdAt, emailedAt, emailError, checkedInAt`.

- Browse or export it with MongoDB Compass (Export → CSV), or from the command line:

  ```bash
  mongoexport --uri "mongodb://127.0.0.1:27017/amas" --collection registrations --type csv --out registrations.csv --fields name,email,phone,ageRange,heardFrom,heardFromOther,attending,transport,pickup,church,assistance,prayer,updates,code,createdAt,checkedInAt
  ```

- To get the riders list for planning buses, filter on `{ "transport": true }` and look at the `pickup` and `phone` columns.
- To find people whose email failed, filter on `{ "emailError": { "$exists": true } }`.

## Changing event details

The event details appear in four places: `EVENT` in `server.js` (the email), `public/index.html`, `public/ticket.html` and `public/nopaw.ics`.
The age ranges and "how did you hear" options are defined in both `server.js` and `public/index.html`, so keep the two lists in sync.
