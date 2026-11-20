import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// ── Local submission store (self-hosted inbox) ──────────────────────────
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'submissions.jsonl');

app.use(cors({ origin: process.env.APP_URL || '*' }));
app.use(express.json());

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
    fs.closeSync(fs.openSync(DB_FILE, 'a'));
}

const readSubmissions = () => {
    try {
        const txt = fs.readFileSync(DB_FILE, 'utf8').trim();
        if (!txt) return [];
        return txt
            .split('\n')
            .map((line) => {
                try { return JSON.parse(line); } catch { return null; }
            })
            .filter(Boolean);
    } catch {
        return [];
    }
};

const sanitize = (s) => String(s ?? '').replace(/[\r\n]/g, ' ').trim();
const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ── Standardized Email Templates (Person + Pillar + Selected Event Type) ──
const PILLAR_META = {
    'gather':         { label: 'Gather Experience',    eventKey: 'event' },
    'shared-moments': { label: 'Gather Experience',    eventKey: 'event' },
    'retreat':        { label: 'Retreat Experience',   eventKey: 'retreatType' },
    'retreats':       { label: 'Retreat Experience',   eventKey: 'retreatType' },
    'faith':          { label: 'Faith Experience',     eventKey: 'gatheringType' },
    'corporate':      { label: 'Corporate Experience', eventKey: 'focusArea' },
    'team':           { label: 'Corporate Experience', eventKey: 'focusArea' },
    'general':        { label: 'General Enquiry',      eventKey: 'pillar' },
    'contact':        { label: 'Contact Enquiry',      eventKey: 'subject' },
};

const buildEmail = (type, formData) => {
    const meta = PILLAR_META[type] || PILLAR_META['general'];
    const selectedEvent = formData[meta.eventKey] || formData.subject || 'General';
    const personName = formData.name || 'Visitor';
    const personEmail = formData.email || '—';
    const personPhone = formData.phone || 'Not provided';

    const subject = `[Garden of Vee] ${meta.label} — ${selectedEvent} | ${personName}`;

    const detailRows = [
        ['Experience Pillar', meta.label],
        ['Selected Event / Type', selectedEvent],
        ['Person Name', personName],
        ['Email Address', personEmail],
        ['Phone Number', personPhone],
    ];

    if (formData.organisation) detailRows.push(['Organisation', formData.organisation]);
    if (formData.groupSize)    detailRows.push(['Group Size', formData.groupSize]);
    if (formData.attendees)    detailRows.push(['Attendees', formData.attendees]);
    if (formData.teamSize)     detailRows.push(['Team Size', formData.teamSize]);
    if (formData.format)       detailRows.push(['Preferred Format', formData.format]);
    if (formData.firstTime)    detailRows.push(['Attended Before', formData.firstTime]);
    if (formData.dates)        detailRows.push(['Preferred Dates', formData.dates]);

    const messageText = formData.message || formData.requirements || 'No additional notes provided.';

    const body =
        `Hello Garden of Vee,\n\n` +
        `A new website enquiry has been submitted.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `ENQUIRY SUMMARY\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        detailRows.map(([k, v]) => `${(k + ':').padEnd(24, ' ')}${v}`).join('\n') +
        `\n\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `MESSAGE / NOTES\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${messageText}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Sent via gardenofvee.africa`;

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;background:#fcfbf9;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden;">
        <div style="background:#1a1a1a;color:#ffffff;padding:24px 28px;">
          <div style="font-size:11px;letter-spacing:0.25em;text-transform:uppercase;color:#D16B3D;font-weight:bold;">${escapeHtml(meta.label)}</div>
          <h2 style="margin:6px 0 0;font-size:20px;font-weight:600;">${escapeHtml(selectedEvent)}</h2>
          <p style="margin:6px 0 0;font-size:13px;color:#cccccc;">From ${escapeHtml(personName)} (${escapeHtml(personEmail)})</p>
        </div>
        <div style="padding:24px 28px;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            ${detailRows.map(([k, v]) => `
              <tr>
                <td style="padding:8px 0;border-bottom:1px solid #eeeeee;color:#666666;width:42%;vertical-align:top;"><strong>${escapeHtml(k)}</strong></td>
                <td style="padding:8px 0;border-bottom:1px solid #eeeeee;color:#1a1a1a;">${escapeHtml(v)}</td>
              </tr>
            `).join('')}
          </table>
          <div style="margin-top:20px;padding:16px;background:#ffffff;border:1px solid #eeeeee;border-radius:8px;">
            <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#D16B3D;font-weight:bold;margin-bottom:8px;">Message / Notes</div>
            <div style="font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(messageText)}</div>
          </div>
          <p style="margin:20px 0 0;font-size:12px;color:#888888;">Reply directly to this email to respond to ${escapeHtml(personName)}.</p>
        </div>
      </div>
    `;

    return { subject, body, html };
};

const storeSubmission = (type, formData) => {
    const { subject, body } = buildEmail(type, formData);
    const record = {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
        type,
        receivedAt: new Date().toISOString(),
        subject,
        body,
        data: formData,
    };
    fs.appendFileSync(DB_FILE, JSON.stringify(record) + '\n', 'utf8');
    return record;
};

// ── Optional SMTP relay (only active when credentials are supplied) ──────
const useSmtp = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
let transporter = null;
if (useSmtp) {
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: false,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
}

// ── Admin auth (localhost-only when no token is configured) ──────────────
const isLocalIp = (ip) => {
    const first = (ip || '').split(',')[0].trim();
    return first === '127.0.0.1' || first === '::1' || first === 'localhost' || first.startsWith('::ffff:127.0.0.1');
};

const requireAdmin = (req, res, next) => {
    const token = process.env.SUBMISSIONS_TOKEN;
    if (token) {
        const provided = req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : req.query.token;
        if (provided !== token) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return next();
    }
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (isLocalIp(ip)) {
        return next();
    }
    return res.status(403).json({ error: 'Forbidden (localhost only)' });
};

// ── Self-hosted admin inbox page ─────────────────────────────────────────
const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Garden of Vee — Inbox</title>
  <style>
    :root{--clay:#D16B3D;--sage:#717254;--deep:#1a1a1a;--warm:#fcfbf9}
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{margin:0;font-family:'Inter',system-ui,sans-serif;background:var(--warm);color:var(--deep);min-height:100vh}
    header{background:var(--deep);color:#fff;padding:clamp(1rem,3vw,1.5rem) clamp(1.5rem,4vw,3rem);display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
    header h1{font-family:'Playfair Display',serif;font-size:clamp(1.4rem,3.5vw,2rem);margin:0;font-weight:500}
    header .count{opacity:.7;font-size:.85rem}
    main{padding:clamp(1.5rem,4vw,3rem);max-width:1100px;margin:0 auto}
    #token-panel{background:#fff;border:1px solid #e5e5e5;border-radius:16px;padding:1.5rem;margin-bottom:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.05)}
    #token-panel input{width:100%;padding:.7rem 1rem;border:1px solid #d1d1d1;border-radius:10px;font-size:.95rem}
    .row{background:#fff;border:1px solid #e5e5e5;border-radius:16px;padding:1.1rem 1.25rem;margin-bottom:1rem;box-shadow:0 1px 3px rgba(0,0,0,.04);cursor:pointer;transition:box-shadow .15s,border-color .15s}
    .row:hover{border-color:var(--clay);box-shadow:0 6px 20px rgba(209,107,61,.08)}
    .row .head{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
    .row .head .t{font-weight:600;color:var(--clay);font-size:.7rem;text-transform:uppercase;letter-spacing:.04em}
    .row .head .s{font-size:clamp(.95rem,2vw,1.1rem);margin:.25rem 0;color:var(--deep)}
    .row .head .when{font-size:.75rem;color:#888;margin-left:auto;text-align:right}
    .detail{margin-top:1rem;padding-top:1rem;border-top:1px solid #eee;font-size:.85rem;color:#555;white-space:pre-wrap;word-break:break-word}
    .empty{color:#888;padding:2rem;text-align:center}
    .kv{display:grid;grid-template-columns:max-content 1fr;gap:.35rem .8rem;font-size:.82rem}
    .kv dt{color:#888}
    .kv dd{margin:0}
  </style>
</head>
<body>
  <header>
    <h1>Garden of Vee Inbox</h1>
    <span class="count" id="count"></span>
  </header>
  <main>
    <div id="token-panel">
      <input id="token" type="password" placeholder="Access token (leave empty for localhost)" autocomplete="off">
    </div>
    <div id="list"><div class="empty">Loading…</div></div>
  </main>
  <script>
    const tokenInput = document.getElementById('token');
    const list = document.getElementById('list');
    const count = document.getElementById('count');
    const headers = () => tokenInput.value ? { 'Authorization': 'Bearer ' + tokenInput.value } : {};
    async function load(){
      list.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const res = await fetch('/api/submissions', { headers: headers() });
        if (res.status === 401 || res.status === 403) {
          list.innerHTML = '<div class="empty">Enter a valid access token above.</div>';
          return;
        }
        const rows = await res.json();
        count.textContent = rows.length + ' submission(s)';
        if (!rows.length) { list.innerHTML = '<div class="empty">No submissions yet.</div>'; return; }
        list.innerHTML = rows.map(r => \`
          <div class="row" data-id="\${r.id}">
            <div class="head">
              <div>
                <div class="t">\${r.type}</div>
                <div class="s">\${r.subject}</div>
              </div>
              <div class="when">\${new Date(r.receivedAt).toLocaleString()}</div>
            </div>
          </div>
        \`).join('');
        document.querySelectorAll('.row').forEach(el => {
          el.addEventListener('click', () => {
            const id = el.getAttribute('data-id');
            if (el.querySelector('.detail')) { el.querySelector('.detail').remove(); return; }
            fetch('/api/submissions/' + id, { headers: headers() })
              .then(r => r.json())
              .then(d => {
                const d2 = d.data || {};
                let kv = '<div class="kv">';
                for (const [k,v] of Object.entries(d2)) kv += '<dt>'+k+'</dt><dd>'+v+'</dd>';
                kv += '</div>';
                const div = document.createElement('div');
                div.className = 'detail';
                div.innerHTML = '<strong>Subject:</strong> ' + (d.subject||'') + '<br><strong>Type:</strong> ' + (d.type||'') + '<br><strong>Received:</strong> ' + new Date(d.receivedAt).toLocaleString() + '<br><br>' + kv + '<br><strong>Email body:</strong><br>' + (d.body||'');
                el.appendChild(div);
              });
          });
        });
      } catch (e) {
        list.innerHTML = '<div class="empty">Failed to load.</div>';
      }
    }
    tokenInput.addEventListener('keypress', e => { if(e.key==='Enter') load(); });
    load();
    setInterval(load, 30000);
  </script>
</body>
</html>`;

app.get('/admin', requireAdmin, (req, res) => {
    res.send(ADMIN_PAGE);
});

app.get('/api/submissions', requireAdmin, (req, res) => {
    res.json(readSubmissions().reverse());
});

app.get('/api/submissions/:id', requireAdmin, (req, res) => {
    const rec = readSubmissions().find((r) => r.id === req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json(rec);
});

// ── Form endpoints ───────────────────────────────────────────────────────
const ENQUIRY_TYPES = ['gather', 'retreat', 'faith', 'corporate', 'general', 'shared-moments', 'retreats', 'team'];

app.post('/api/enquiry', async (req, res) => {
    const { type, formData } = req.body;

    if (!type || !ENQUIRY_TYPES.includes(type) || !formData?.name || !formData?.email) {
        return res.status(400).json({ error: 'Missing required fields: type, name, or email' });
    }

    try {
        const record = storeSubmission(type, formData);

        if (useSmtp) {
            try {
                const { subject, body, html } = buildEmail(type, formData);
                await transporter.sendMail({
                    from: `"Garden of Vee" <${process.env.SMTP_USER}>`,
                    to: process.env.SMTP_TO || 'Gardenofvee.info@gmail.com',
                    subject: sanitize(subject),
                    text: body,
                    html,
                    replyTo: formData.email,
                });
            } catch (mailErr) {
                console.error('SMTP relay failed (submission still stored locally):', mailErr.message);
            }
        }

        res.json({ success: true, message: 'Enquiry received', stored: true, id: record.id });
    } catch (error) {
        console.error('Enquiry error:', error);
        res.status(500).json({ error: 'Failed to record enquiry', details: error.message });
    }
});

app.post('/api/contact', async (req, res) => {
    const { name, email, phone, message } = req.body;

    if (!name || !email || !message) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const record = storeSubmission('contact', { name, email, phone, message });

        if (useSmtp) {
            try {
                const { subject, body, html } = buildEmail('contact', { name, email, phone, message });
                await transporter.sendMail({
                    from: `"Garden of Vee Contact" <${process.env.SMTP_USER}>`,
                    to: process.env.SMTP_TO || 'Gardenofvee.info@gmail.com',
                    subject: sanitize(subject),
                    text: body,
                    html,
                    replyTo: email,
                });
            } catch (mailErr) {
                console.error('SMTP relay failed (submission still stored locally):', mailErr.message);
            }
        }

        res.json({ success: true, message: 'Contact message received', stored: true, id: record.id });
    } catch (error) {
        console.error('Contact error:', error);
        res.status(500).json({ error: 'Failed to record message', details: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', smtp: useSmtp });
});

// ── Serve built dist/ assets & SPA fallback when dist/index.html exists ─
const DIST_DIR = path.join(process.cwd(), 'dist');
if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api') || req.path === '/admin') return next();
        const indexFile = path.join(DIST_DIR, 'index.html');
        if (fs.existsSync(indexFile)) {
            return res.sendFile(indexFile);
        }
        return next();
    });
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Admin inbox: http://localhost:${port}/admin`);
    console.log(`Submissions stored in: ${DB_FILE}`);
});
