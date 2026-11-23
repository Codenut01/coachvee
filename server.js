import express from 'express';
import fs from 'fs';
import path from 'path';
import dns from 'dns';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import cors from 'cors';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname;

const app = express();
const port = Number(process.env.PORT) || 3001;

// ── Self-contained storage paths (no .env file required) ──────────────────
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'submissions.jsonl');
const CONFIG_FILE = path.join(DATA_DIR, 'mail-config.json');

const DEFAULT_CONFIG = {
    recipientEmail: 'Gardenofvee.info@gmail.com',
    brandName: 'Garden of Vee',
    fromName: 'Garden of Vee',
    fromEmail: 'noreply@gardenofvee.africa',
    deliveryMode: 'auto', // 'auto' | 'smtp' | 'sendmail' | 'direct-mx' | 'inbox-only'
    smtp: {
        host: '',
        port: 587,
        secure: false,
        user: '',
        pass: '',
    },
    autoReply: {
        enabled: false,
        subject: 'We received your enquiry — Garden of Vee',
        message:
            'Thank you for reaching out to Garden of Vee. We have received your enquiry and will respond within 24 hours.\n\nWarmly,\nGarden of Vee',
    },
    adminToken: '',
};

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, '', 'utf8');
}
if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
}

app.use(cors({ origin: process.env.APP_URL || '*' }));
app.use(express.json({ limit: '1mb' }));

// ── Helpers: validation, sanitization, escaping ───────────────────────────
const sanitizeHeader = (s) => String(s ?? '').replace(/[\r\n\0]+/g, ' ').trim();
const sanitizeEmail = (s) => sanitizeHeader(s).replace(/[<>]/g, '');
const cleanText = (s) => String(s ?? '').replace(/\0/g, '').trim();
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText(email));

const escapeHtml = (s) =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const encodeMimeHeader = (str) => {
    const clean = sanitizeHeader(str);
    if (/^[\x20-\x7E]*$/.test(clean)) return clean;
    return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
};

const wrapBase64 = (str) => {
    const b64 = Buffer.from(String(str ?? ''), 'utf8').toString('base64');
    return (b64.match(/.{1,76}/g) || ['']).join('\r\n');
};

// ── Config store (self-contained in data/mail-config.json) ────────────────
const readFileConfig = () => {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

const getEffectiveConfig = () => {
    const fileCfg = readFileConfig();
    const envPort = Number(process.env.SMTP_PORT || 587);
    const cfgPort = Number(fileCfg.smtp?.port || envPort || 587);
    return {
        recipientEmail: cleanText(fileCfg.recipientEmail || process.env.SMTP_TO || DEFAULT_CONFIG.recipientEmail),
        brandName: cleanText(fileCfg.brandName || DEFAULT_CONFIG.brandName),
        fromName: cleanText(fileCfg.fromName || DEFAULT_CONFIG.fromName),
        fromEmail: cleanText(fileCfg.fromEmail || process.env.SMTP_FROM || DEFAULT_CONFIG.fromEmail),
        deliveryMode: cleanText(fileCfg.deliveryMode || DEFAULT_CONFIG.deliveryMode) || 'auto',
        smtp: {
            host: cleanText(fileCfg.smtp?.host || process.env.SMTP_HOST || (process.env.SMTP_USER ? 'smtp.gmail.com' : '')),
            port: cfgPort,
            secure: typeof fileCfg.smtp?.secure === 'boolean' ? fileCfg.smtp.secure : cfgPort === 465,
            user: cleanText(fileCfg.smtp?.user || process.env.SMTP_USER || ''),
            pass: String(fileCfg.smtp?.pass || process.env.SMTP_PASS || ''),
        },
        autoReply: {
            enabled: Boolean(fileCfg.autoReply?.enabled),
            subject: cleanText(fileCfg.autoReply?.subject || DEFAULT_CONFIG.autoReply.subject),
            message: String(fileCfg.autoReply?.message || DEFAULT_CONFIG.autoReply.message),
        },
        adminToken: String(fileCfg.adminToken || process.env.SUBMISSIONS_TOKEN || ''),
    };
};

const writeFileConfig = (nextCfg) => {
    const tmpFile = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(nextCfg, null, 2), 'utf8');
    fs.renameSync(tmpFile, CONFIG_FILE);
};

// ── Serialized JSONL store (safe concurrent updates) ──────────────────────
let dbQueue = Promise.resolve();
const withDbLock = (fn) => {
    const run = dbQueue.then(fn, fn);
    dbQueue = run.catch(() => {});
    return run;
};

const readSubmissions = () => {
    try {
        const txt = fs.readFileSync(DB_FILE, 'utf8').trim();
        if (!txt) return [];
        return txt
            .split('\n')
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    } catch {
        return [];
    }
};

const writeAllSubmissions = (records) => {
    const content = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
    const tmpFile = DB_FILE + '.tmp';
    fs.writeFileSync(tmpFile, content, 'utf8');
    fs.renameSync(tmpFile, DB_FILE);
};

const appendSubmission = (record) =>
    withDbLock(() => {
        fs.appendFileSync(DB_FILE, JSON.stringify(record) + '\n', 'utf8');
        return record;
    });

const updateSubmission = (id, mutator) =>
    withDbLock(() => {
        const rows = readSubmissions();
        const idx = rows.findIndex((r) => r.id === id);
        if (idx === -1) return null;
        const updated = mutator({ ...rows[idx] });
        rows[idx] = updated;
        writeAllSubmissions(rows);
        return updated;
    });

const deleteSubmission = (id) =>
    withDbLock(() => {
        const rows = readSubmissions();
        const next = rows.filter((r) => r.id !== id);
        if (next.length === rows.length) return false;
        writeAllSubmissions(next);
        return true;
    });

// ── Type Normalization & Email Templates ──────────────────────────────────
const TYPE_ALIASES = {
    'gather': 'gather',
    'gather-experience': 'gather',
    'shared-moments': 'gather',
    'retreat': 'retreat',
    'retreats': 'retreat',
    'retreat-experience': 'retreat',
    'faith': 'faith',
    'faith-experience': 'faith',
    'corporate': 'corporate',
    'corporate-experience': 'corporate',
    'team': 'corporate',
    'general': 'general',
    'contact': 'contact',
};

const sanitizeFormData = (raw) => {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [k, v] of Object.entries(raw)) {
        if (typeof k !== 'string') continue;
        out[k] = cleanText(v);
    }
    return out;
};

const buildStyledHtmlEmail = ({ pillarLabel, title, rows, noteLabel, noteText }) => {
    const rowHtml = rows
        .map(
            ([label, value]) => `
            <tr>
                <td style="padding:10px 14px;border-bottom:1px solid #ece7df;color:#7a746c;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;width:165px;vertical-align:top;">${escapeHtml(label)}</td>
                <td style="padding:10px 14px;border-bottom:1px solid #ece7df;color:#1a1a1a;font-size:14px;vertical-align:top;">${escapeHtml(value || '—')}</td>
            </tr>`
        )
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:24px;background:#faf7f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e9e2d8;box-shadow:0 8px 30px rgba(0,0,0,0.05);">
    <div style="background:#161514;padding:28px 32px;border-bottom:3px solid #D16B3D;">
      <div style="font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:#D16B3D;font-weight:700;margin-bottom:6px;">${escapeHtml(pillarLabel)}</div>
      <h1 style="margin:0;font-family:Georgia,serif;font-weight:500;font-size:24px;color:#ffffff;">${escapeHtml(title)}</h1>
    </div>
    <div style="padding:28px 32px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">${rowHtml}</table>
      <div style="background:#faf7f2;border:1px solid #ece5db;border-radius:12px;padding:16px 18px;">
        <div style="font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:#717254;font-weight:700;margin-bottom:8px;">${escapeHtml(noteLabel)}</div>
        <div style="font-size:14px;line-height:1.65;color:#2c2926;white-space:pre-wrap;">${escapeHtml(noteText || 'None provided.')}</div>
      </div>
      <div style="margin-top:24px;font-size:11px;color:#8c857d;letter-spacing:0.06em;">Sent via Garden of Vee · gardenofvee.africa</div>
    </div>
  </div>
</body>
</html>`;
};

const buildEmail = (canonicalType, formData) => {
    const f = sanitizeFormData(formData);

    const templates = {
        gather: () => {
            const subject = `[Garden of Vee] Gather Experience — ${f.event || 'General'} | ${f.name || 'Enquiry'}`;
            const rows = [
                ['Pillar', 'Gather Experience'],
                ['Event Type', f.event || '—'],
                ['Full Name', f.name || '—'],
                ['Email Address', f.email || '—'],
                ['Phone Number', f.phone || '—'],
                ['Group Size', f.groupSize || '—'],
                ['Preferred Dates', f.dates || '—'],
            ];
            const body =
                `Hello Garden of Vee,\n\n` +
                `I would like to enquire about the Gather Experience.\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `ENQUIRY DETAILS\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                rows.map(([k, v]) => `${(k + ':').padEnd(18)} ${v}`).join('\n') +
                `\n\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `MESSAGE\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `${f.message || 'No additional message.'}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Sent via gardenofvee.africa`;
            const html = buildStyledHtmlEmail({
                pillarLabel: 'Gather Experience',
                title: f.event ? `Gather Enquiry — ${f.event}` : 'New Gather Experience Enquiry',
                rows,
                noteLabel: 'Message',
                noteText: f.message || 'No additional message.',
            });
            return { subject, body, html };
        },
        retreat: () => {
            const subject = `[Garden of Vee] Retreat Experience — ${f.retreatType || 'General'} | ${f.name || 'Enquiry'}`;
            const rows = [
                ['Pillar', 'Retreat Experience'],
                ['Retreat Type', f.retreatType || '—'],
                ['Full Name', f.name || '—'],
                ['Email Address', f.email || '—'],
                ['Phone Number', f.phone || '—'],
                ['Attendees', f.attendees || '—'],
                ['Preferred Dates', f.dates || '—'],
            ];
            const body =
                `Hello Garden of Vee,\n\n` +
                `I would like to enquire about a Retreat Experience.\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `ENQUIRY DETAILS\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                rows.map(([k, v]) => `${(k + ':').padEnd(18)} ${v}`).join('\n') +
                `\n\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `NOTES / INTENTIONS\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `${f.requirements || f.message || 'None specified.'}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Sent via gardenofvee.africa`;
            const html = buildStyledHtmlEmail({
                pillarLabel: 'Retreat Experience',
                title: f.retreatType ? `Retreat Enquiry — ${f.retreatType}` : 'New Retreat Experience Enquiry',
                rows,
                noteLabel: 'Notes / Intentions',
                noteText: f.requirements || f.message || 'None specified.',
            });
            return { subject, body, html };
        },
        faith: () => {
            const subject = `[Garden of Vee] Faith Experience — ${f.gatheringType || 'General'} | ${f.name || 'Enquiry'}`;
            const rows = [
                ['Pillar', 'Faith Experience'],
                ['Session Type', f.gatheringType || '—'],
                ['Full Name', f.name || '—'],
                ['Email Address', f.email || '—'],
                ['Phone Number', f.phone || '—'],
                ['Attended Before', f.firstTime || '—'],
            ];
            const body =
                `Hello Garden of Vee,\n\n` +
                `I would like to join a Faith Experience.\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `ENQUIRY DETAILS\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                rows.map(([k, v]) => `${(k + ':').padEnd(18)} ${v}`).join('\n') +
                `\n\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `MESSAGE / PRAYER REQUEST\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `${f.message || 'None shared.'}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Sent via gardenofvee.africa`;
            const html = buildStyledHtmlEmail({
                pillarLabel: 'Faith Experience',
                title: f.gatheringType ? `Faith Enquiry — ${f.gatheringType}` : 'New Faith Experience Enquiry',
                rows,
                noteLabel: 'Message / Prayer Request',
                noteText: f.message || 'None shared.',
            });
            return { subject, body, html };
        },
        corporate: () => {
            const subject = `[Garden of Vee] Corporate Experience — ${f.focusArea || 'General'} | ${f.organisation || f.name || 'Enquiry'}`;
            const rows = [
                ['Pillar', 'Corporate Experience'],
                ['Focus Area', f.focusArea || '—'],
                ['Full Name', f.name || '—'],
                ['Work Email', f.email || '—'],
                ['Phone Number', f.phone || '—'],
                ['Organisation', f.organisation || '—'],
                ['Team Size', f.teamSize || '—'],
                ['Preferred Format', f.format || '—'],
            ];
            const body =
                `Hello Garden of Vee,\n\n` +
                `I would like to enquire about a Corporate Experience.\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `ENQUIRY DETAILS\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                rows.map(([k, v]) => `${(k + ':').padEnd(18)} ${v}`).join('\n') +
                `\n\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `CONTEXT / GOALS\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `${f.message || 'None specified.'}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Sent via gardenofvee.africa`;
            const html = buildStyledHtmlEmail({
                pillarLabel: 'Corporate Experience',
                title: f.organisation ? `Corporate Enquiry — ${f.organisation}` : 'New Corporate Experience Enquiry',
                rows,
                noteLabel: 'Context / Goals',
                noteText: f.message || 'None specified.',
            });
            return { subject, body, html };
        },
        general: () => {
            const topic = f.pillar || f.subject || 'General Enquiry';
            const subject = `[Garden of Vee] ${topic} | ${f.name || 'Enquiry'}`;
            const rows = [
                ['Experience / Topic', topic],
                ['Full Name', f.name || '—'],
                ['Email Address', f.email || '—'],
                ['Phone Number', f.phone || '—'],
            ];
            const body =
                `Hello Garden of Vee,\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `ENQUIRY DETAILS\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                rows.map(([k, v]) => `${(k + ':').padEnd(20)} ${v}`).join('\n') +
                `\n\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `MESSAGE\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `${f.message || '—'}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Sent via gardenofvee.africa`;
            const html = buildStyledHtmlEmail({
                pillarLabel: 'Garden of Vee',
                title: topic,
                rows,
                noteLabel: 'Message',
                noteText: f.message || '—',
            });
            return { subject, body, html };
        },
        contact: () => {
            const subject = `[Garden of Vee] Contact Form — ${f.name || 'Message'}`;
            const rows = [
                ['Full Name', f.name || '—'],
                ['Email Address', f.email || '—'],
                ['Phone Number', f.phone || 'Not provided'],
            ];
            const body =
                `Hello Garden of Vee,\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `CONTACT DETAILS\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                rows.map(([k, v]) => `${(k + ':').padEnd(18)} ${v}`).join('\n') +
                `\n\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                `MESSAGE\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `${f.message || '—'}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Sent via gardenofvee.africa`;
            const html = buildStyledHtmlEmail({
                pillarLabel: 'Contact Form',
                title: `Message from ${f.name || 'Visitor'}`,
                rows,
                noteLabel: 'Message',
                noteText: f.message || '—',
            });
            return { subject, body, html };
        },
    };

    return (templates[canonicalType] || templates.general)();
};

const buildRawEml = (record, config) => {
    const boundary = `----=_Part_${record.id}_${crypto.randomBytes(6).toString('hex')}`;
    const fromEmail = sanitizeEmail(config.smtp?.user || config.fromEmail || DEFAULT_CONFIG.fromEmail);
    const toEmail = sanitizeEmail(config.recipientEmail || DEFAULT_CONFIG.recipientEmail);
    const replyEmail = sanitizeEmail(record.data?.email || '');
    const replyName = sanitizeHeader(record.data?.name || '');
    const replyHeader = replyEmail ? (replyName ? `${encodeMimeHeader(replyName)} <${replyEmail}>` : `<${replyEmail}>`) : '';

    const headers = [
        `MIME-Version: 1.0`,
        `Date: ${new Date(record.receivedAt || Date.now()).toUTCString()}`,
        `Message-ID: <${sanitizeHeader(record.id)}@gardenofvee.africa>`,
        `From: ${encodeMimeHeader(config.fromName || 'Garden of Vee')} <${fromEmail}>`,
        `To: <${toEmail}>`,
        ...(replyHeader ? [`Reply-To: ${replyHeader}`] : []),
        `Subject: ${encodeMimeHeader(record.subject || 'Garden of Vee Enquiry')}`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];

    const textBody = record.body || '';
    const htmlBody = record.html || `<pre style="font-family:sans-serif;white-space:pre-wrap;">${escapeHtml(textBody)}</pre>`;

    return [
        ...headers,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(textBody),
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(htmlBody),
        '',
        `--${boundary}--`,
        '',
    ].join('\r\n');
};

// ── Self-Contained Multi-Tier Email Delivery Engine ───────────────────────
const findSendmailPath = () => {
    const candidates = ['/usr/sbin/sendmail', '/usr/lib/sendmail', '/usr/bin/sendmail'];
    return candidates.find((p) => fs.existsSync(p)) || null;
};

const sendViaConfiguredSmtp = async (mail, smtpCfg) => {
    const portNum = Number(smtpCfg.port) || 587;
    const secure = typeof smtpCfg.secure === 'boolean' ? smtpCfg.secure : portNum === 465;
    const transporter = nodemailer.createTransport({
        host: smtpCfg.host,
        port: portNum,
        secure,
        auth: {
            user: smtpCfg.user,
            pass: smtpCfg.pass,
        },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 12000,
    });
    const info = await transporter.sendMail({
        from: `"${sanitizeHeader(mail.fromName)}" <${sanitizeEmail(smtpCfg.user)}>`,
        to: sanitizeEmail(mail.to),
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        subject: sanitizeHeader(mail.subject),
        text: mail.text,
        html: mail.html,
    });
    return { delivered: true, status: 'delivered', method: 'smtp', messageId: info.messageId, detail: `Sent via SMTP (${smtpCfg.host}:${portNum})` };
};

const sendViaSendmail = async (mail, sendmailPath) => {
    const transporter = nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: sendmailPath,
    });
    const info = await transporter.sendMail({
        from: `"${sanitizeHeader(mail.fromName)}" <${sanitizeEmail(mail.fromEmail)}>`,
        to: sanitizeEmail(mail.to),
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        subject: sanitizeHeader(mail.subject),
        text: mail.text,
        html: mail.html,
    });
    return { delivered: true, status: 'delivered', method: 'sendmail', messageId: info.messageId, detail: `Sent via local sendmail (${sendmailPath})` };
};

const sendViaLocalhostMta = async (mail) => {
    const transporter = nodemailer.createTransport({
        host: '127.0.0.1',
        port: 25,
        secure: false,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 1000,
        greetingTimeout: 1500,
        socketTimeout: 4000,
    });
    const info = await transporter.sendMail({
        from: `"${sanitizeHeader(mail.fromName)}" <${sanitizeEmail(mail.fromEmail)}>`,
        to: sanitizeEmail(mail.to),
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        subject: sanitizeHeader(mail.subject),
        text: mail.text,
        html: mail.html,
    });
    return { delivered: true, status: 'delivered', method: 'local-mta', messageId: info.messageId, detail: 'Sent via localhost:25 MTA' };
};

const sendViaDirectMx = async (mail) => {
    const recipient = sanitizeEmail(mail.to);
    const domain = recipient.split('@')[1];
    if (!domain) throw new Error('Invalid recipient email domain');

    const mxRecords = await dns.promises.resolveMx(domain);
    if (!mxRecords || !mxRecords.length) {
        throw new Error(`No MX records found for ${domain}`);
    }

    const targets = [...mxRecords].sort((a, b) => a.priority - b.priority).slice(0, 2);
    let lastError = null;

    for (const mx of targets) {
        try {
            const transporter = nodemailer.createTransport({
                host: mx.exchange,
                port: 25,
                secure: false,
                tls: { rejectUnauthorized: false },
                connectionTimeout: 3000,
                greetingTimeout: 3000,
                socketTimeout: 5000,
            });
            const info = await transporter.sendMail({
                from: `"${sanitizeHeader(mail.fromName)}" <${sanitizeEmail(mail.fromEmail)}>`,
                to: recipient,
                ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
                subject: sanitizeHeader(mail.subject),
                text: mail.text,
                html: mail.html,
            });
            return {
                delivered: true,
                status: 'delivered',
                method: 'direct-mx',
                messageId: info.messageId,
                detail: `Sent directly via MX (${mx.exchange}:25)`,
            };
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Direct MX connection failed');
};

const deliverEmail = async (mail, config) => {
    const mode = config.deliveryMode || 'auto';
    const smtpReady = Boolean(config.smtp?.host && config.smtp?.user && config.smtp?.pass);
    const sendmailPath = findSendmailPath();

    if (mode === 'inbox-only') {
        return {
            delivered: false,
            status: 'stored-only',
            method: 'local-inbox',
            detail: 'Saved to self-hosted inbox (Inbox-Only mode).',
            error: null,
        };
    }

    if (mode === 'smtp') {
        if (!smtpReady) {
            return {
                delivered: false,
                status: 'failed',
                method: 'smtp',
                detail: 'SMTP mode selected, but SMTP host/user/password are not configured in Mail Settings.',
                error: 'Incomplete SMTP settings',
            };
        }
        try {
            return await sendViaConfiguredSmtp(mail, config.smtp);
        } catch (err) {
            return { delivered: false, status: 'failed', method: 'smtp', detail: err.message, error: err.message };
        }
    }

    if (mode === 'sendmail') {
        if (!sendmailPath) {
            return {
                delivered: false,
                status: 'failed',
                method: 'sendmail',
                detail: 'Sendmail binary not found on this host.',
                error: 'Sendmail unavailable',
            };
        }
        try {
            return await sendViaSendmail(mail, sendmailPath);
        } catch (err) {
            return { delivered: false, status: 'failed', method: 'sendmail', detail: err.message, error: err.message };
        }
    }

    if (mode === 'direct-mx') {
        try {
            return await sendViaDirectMx(mail);
        } catch (err) {
            return { delivered: false, status: 'failed', method: 'direct-mx', detail: err.message, error: err.message };
        }
    }

    // 'auto' mode: SMTP (if configured) -> local sendmail -> localhost:25 -> direct MX -> self-hosted inbox
    if (smtpReady) {
        try {
            return await sendViaConfiguredSmtp(mail, config.smtp);
        } catch (err) {
            return {
                delivered: false,
                status: 'failed',
                method: 'smtp',
                detail: `SMTP failed (${err.message}); preserved in self-hosted inbox.`,
                error: err.message,
            };
        }
    }

    const errors = [];
    if (sendmailPath) {
        try {
            return await sendViaSendmail(mail, sendmailPath);
        } catch (err) {
            errors.push(`sendmail: ${err.message}`);
        }
    }

    try {
        return await sendViaLocalhostMta(mail);
    } catch (err) {
        errors.push(`localhost:25: ${err.message}`);
    }

    try {
        return await sendViaDirectMx(mail);
    } catch (err) {
        errors.push(`direct-mx: ${err.message}`);
    }

    return {
        delivered: false,
        status: 'stored-only',
        method: 'local-inbox',
        detail: `Saved in self-hosted inbox (external relay unavailable: ${errors.join(' | ')})`,
        error: errors.join(' | '),
    };
};

const sendAutoReplyIfEnabled = async (record, config) => {
    if (!config.autoReply?.enabled) return null;
    const visitorEmail = sanitizeEmail(record.data?.email || '');
    if (!isValidEmail(visitorEmail)) return null;

    // Only attempt auto-reply if we have a real outbound relay (configured SMTP or local sendmail/MTA)
    const smtpReady = Boolean(config.smtp?.host && config.smtp?.user && config.smtp?.pass);
    const sendmailPath = findSendmailPath();
    if (!smtpReady && !sendmailPath) return null;

    const visitorName = sanitizeHeader(record.data?.name || 'there');
    const text = `Hello ${visitorName},\n\n${config.autoReply.message}\n\nReference ID: ${record.id}\nSummary: ${record.subject}`;
    const html = buildStyledHtmlEmail({
        pillarLabel: 'Garden of Vee · Confirmation',
        title: config.autoReply.subject,
        rows: [
            ['Reference ID', record.id],
            ['Enquiry', record.subject],
        ],
        noteLabel: 'Message',
        noteText: config.autoReply.message,
    });

    const mail = {
        fromName: config.fromName || 'Garden of Vee',
        fromEmail: config.fromEmail || DEFAULT_CONFIG.fromEmail,
        to: visitorEmail,
        replyTo: sanitizeEmail(config.recipientEmail || DEFAULT_CONFIG.recipientEmail),
        subject: config.autoReply.subject,
        text,
        html,
    };

    try {
        if (smtpReady) return await sendViaConfiguredSmtp(mail, config.smtp);
        if (sendmailPath) return await sendViaSendmail(mail, sendmailPath);
    } catch (err) {
        return { delivered: false, error: err.message };
    }
    return null;
};

const processSubmissionDelivery = async (recordId) => {
    const config = getEffectiveConfig();
    const record = readSubmissions().find((r) => r.id === recordId);
    if (!record) return null;

    const visitorEmail = sanitizeEmail(record.data?.email || '');
    const visitorName = sanitizeHeader(record.data?.name || '');
    const replyTo = isValidEmail(visitorEmail)
        ? (visitorName ? `"${visitorName}" <${visitorEmail}>` : visitorEmail)
        : undefined;

    const result = await deliverEmail(
        {
            fromName: config.fromName || 'Garden of Vee',
            fromEmail: config.fromEmail || DEFAULT_CONFIG.fromEmail,
            to: config.recipientEmail || DEFAULT_CONFIG.recipientEmail,
            replyTo,
            subject: record.subject,
            text: record.body,
            html: record.html,
        },
        config
    );

    let autoReplyResult = null;
    if (result.delivered) {
        autoReplyResult = await sendAutoReplyIfEnabled(record, config);
    }

    const updated = await updateSubmission(recordId, (cur) => ({
        ...cur,
        delivery: {
            status: result.status,
            method: result.method,
            lastAttemptAt: new Date().toISOString(),
            messageId: result.messageId || null,
            detail: result.detail || null,
            error: result.error || null,
            autoReplySent: Boolean(autoReplyResult?.delivered),
        },
    }));

    return updated;
};

// ── Admin Authentication (zero .env required; localhost works out-of-box) ───
const isLocalIp = (ip) => {
    const parts = String(ip || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (!parts.length) return false;
    return parts.every(
        (addr) => addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || addr === '::ffff:127.0.0.1'
    );
};

const tokensEqual = (a, b) => {
    const ha = crypto.createHash('sha256').update(String(a || '')).digest();
    const hb = crypto.createHash('sha256').update(String(b || '')).digest();
    return crypto.timingSafeEqual(ha, hb);
};

const requireAdmin = (req, res, next) => {
    const config = getEffectiveConfig();
    const token = config.adminToken;

    if (token) {
        const authHeader = req.headers.authorization || '';
        const provided = authHeader.startsWith('Bearer ')
            ? authHeader.slice(7).trim()
            : String(req.query.token || '').trim();
        if (!provided || !tokensEqual(provided, token)) {
            return res.status(401).json({ error: 'Unauthorized: valid passcode required' });
        }
        return next();
    }

    const remoteAddr = req.socket?.remoteAddress || '';
    const xff = req.headers['x-forwarded-for'];
    // Trust localhost only when the actual socket is loopback AND any proxy header is also loopback
    if (isLocalIp(remoteAddr) && (!xff || isLocalIp(xff))) {
        return next();
    }

    return res.status(403).json({
        error: 'Forbidden: admin access without a passcode is restricted to localhost. Set an admin passcode from localhost in /admin Mail Settings.',
    });
};

// ── Self-Hosted Admin Webmail & Settings UI ───────────────────────────────
const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Garden of Vee — Self-Hosted Inbox</title>
  <style>
    :root{--clay:#D16B3D;--clay-soft:rgba(209,107,61,.12);--sage:#717254;--sage-soft:rgba(113,114,84,.14);--deep:#1a1a1a;--warm:#fcfbf9;--border:#e8e2d8}
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{margin:0;font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--warm);color:var(--deep);min-height:100vh}
    header{background:#161514;color:#fff;padding:1.15rem clamp(1rem,4vw,2.5rem);display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;border-bottom:2px solid var(--clay)}
    .brand h1{font-family:Georgia,serif;font-size:clamp(1.25rem,3vw,1.65rem);margin:0;font-weight:500;letter-spacing:.04em}
    .brand .sub{font-size:.72rem;text-transform:uppercase;letter-spacing:.22em;color:var(--clay);margin-top:.25rem}
    .hdr-actions{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap}
    .count{opacity:.75;font-size:.82rem;margin-right:.4rem}
    main{padding:clamp(1rem,3vw,2.25rem);max-width:1100px;margin:0 auto}
    .panel{background:#fff;border:1px solid var(--border);border-radius:16px;padding:1.15rem 1.25rem;margin-bottom:1.25rem;box-shadow:0 2px 10px rgba(0,0,0,.03)}
    .toolbar{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-bottom:1rem}
    .tabs{display:flex;gap:.45rem;flex-wrap:wrap}
    .tab{background:#fff;color:#555;border:1px solid var(--border);padding:.48rem .9rem;border-radius:999px;font-size:.76rem;font-weight:600;cursor:pointer;text-transform:uppercase;letter-spacing:.08em}
    .tab.active{background:var(--deep);color:#fff;border-color:var(--deep)}
    input,select,textarea{font-family:inherit;font-size:.9rem;border:1px solid #d7d0c5;border-radius:10px;padding:.6rem .85rem;background:#fff;color:var(--deep)}
    input:focus,select:focus,textarea:focus{outline:none;border-color:var(--clay)}
    .btn{background:var(--clay);color:#fff;border:none;padding:.58rem 1.05rem;border-radius:10px;font-weight:600;cursor:pointer;font-size:.8rem;letter-spacing:.04em;text-decoration:none;display:inline-flex;align-items:center;gap:.4rem}
    .btn:hover{opacity:.92}
    .btn:disabled{opacity:.55;cursor:not-allowed}
    .btn-dark{background:var(--deep)}
    .btn-ghost{background:#fff;color:var(--deep);border:1px solid var(--border)}
    .btn-ghost:hover{border-color:var(--clay);color:var(--clay)}
    .btn-danger{background:#fff;color:#b42318;border:1px solid #f0c9c6}
    .row{background:#fff;border:1px solid var(--border);border-radius:16px;padding:1.1rem 1.25rem;margin-bottom:.9rem;box-shadow:0 1px 4px rgba(0,0,0,.03);transition:border-color .15s,box-shadow .15s}
    .row.unread{border-left:4px solid var(--clay)}
    .row:hover{border-color:var(--clay);box-shadow:0 6px 20px rgba(209,107,61,.08)}
    .row-head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;cursor:pointer}
    .badges{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;margin-bottom:.35rem}
    .badge{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:.2rem .55rem;border-radius:999px}
    .b-type{background:var(--clay-soft);color:var(--clay)}
    .b-ok{background:#e7f6ec;color:#146c38}
    .b-inbox{background:var(--sage-soft);color:var(--sage)}
    .b-fail{background:#fdecea;color:#b42318}
    .b-status{background:#f3f1ed;color:#555}
    .subj{font-size:1.05rem;font-weight:600;color:var(--deep);margin:.15rem 0}
    .meta-line{font-size:.82rem;color:#6b655e}
    .when{font-size:.76rem;color:#8a8278;margin-left:auto;text-align:right;white-space:nowrap}
    .detail{margin-top:1rem;padding-top:1rem;border-top:1px solid #eee7dd;font-size:.88rem;color:#3a3632}
    .kv{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1rem;font-size:.84rem;background:#faf7f2;padding:.9rem 1rem;border-radius:12px;border:1px solid #ece5db;margin-bottom:1rem}
    .kv dt{color:#777067;font-weight:600}
    .kv dd{margin:0;word-break:break-word}
    .msg-box{background:#fff;border:1px solid #ece5db;border-radius:12px;padding:1rem;white-space:pre-wrap;word-break:break-word;line-height:1.6;margin-bottom:1rem}
    .actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem}
    .reply-box{background:#faf7f2;border:1px solid #e7dfd4;border-radius:12px;padding:1rem;margin-top:.75rem}
    .reply-box textarea{width:100%;min-height:95px;margin:.5rem 0}
    .replies-list{margin-top:.85rem;display:flex;flex-direction:column;gap:.6rem}
    .reply-item{background:#fff;border:1px solid #e6dfd5;border-radius:10px;padding:.75rem .9rem;font-size:.83rem}
    .empty{color:#888;padding:2.5rem;text-align:center}
    .grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.85rem}
    .field label{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.12em;color:#6f685f;font-weight:700;margin-bottom:.35rem}
    .field input,.field select,.field textarea{width:100%}
    .status-note{font-size:.82rem;margin-top:.6rem;padding:.6rem .85rem;border-radius:10px;background:#f5f2ec;color:#444}
    .hidden{display:none!important}
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <h1>Garden of Vee · Self-Hosted Inbox</h1>
      <div class="sub">Enquiries &amp; Self-Contained Mail Center (No .env Required)</div>
    </div>
    <div class="hdr-actions">
      <span class="count" id="count"></span>
      <button type="button" class="btn btn-ghost" id="btn-refresh">Refresh</button>
      <button type="button" class="btn" id="btn-settings">Mail Settings</button>
    </div>
  </header>
  <main>
    <div id="token-panel" class="panel hidden">
      <div style="font-weight:600;margin-bottom:.5rem;">Admin Passcode Required</div>
      <div style="display:flex;gap:.6rem;flex-wrap:wrap;">
        <input id="token" type="password" placeholder="Enter admin passcode" autocomplete="off" style="flex:1;min-width:200px;">
        <button type="button" class="btn" id="btn-unlock">Unlock Inbox</button>
      </div>
      <div id="auth-msg" class="meta-line" style="margin-top:.5rem;"></div>
    </div>

    <div id="settings-panel" class="panel hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1rem;flex-wrap:wrap;">
        <div>
          <strong style="font-size:1.05rem;">Mail Delivery &amp; Inbox Settings</strong>
          <div class="meta-line">Saved directly to <code>data/mail-config.json</code> — no <code>.env</code> file needed.</div>
        </div>
        <button type="button" class="btn btn-ghost" id="btn-close-settings">Close</button>
      </div>
      <div class="grid-2">
        <div class="field">
          <label>Recipient Email (Inbox Destination)</label>
          <input id="cfg-recipient" type="email" placeholder="Gardenofvee.info@gmail.com">
        </div>
        <div class="field">
          <label>Sender Name</label>
          <input id="cfg-from-name" type="text" placeholder="Garden of Vee">
        </div>
        <div class="field">
          <label>Sender Email (Used by Sendmail / Direct MX)</label>
          <input id="cfg-from-email" type="email" placeholder="noreply@gardenofvee.africa">
        </div>
        <div class="field">
          <label>Delivery Mode</label>
          <select id="cfg-mode">
            <option value="auto">Auto (SMTP if set → Sendmail → Local MTA → Direct MX → Inbox)</option>
            <option value="smtp">SMTP Relay Only</option>
            <option value="sendmail">Local Sendmail Only</option>
            <option value="direct-mx">Direct MX (DNS Port 25)</option>
            <option value="inbox-only">Self-Hosted Inbox Only (No Outbound Network)</option>
          </select>
        </div>
        <div class="field">
          <label>Optional SMTP Host</label>
          <input id="cfg-smtp-host" type="text" placeholder="smtp.gmail.com">
        </div>
        <div class="field">
          <label>Optional SMTP Port</label>
          <input id="cfg-smtp-port" type="number" placeholder="587">
        </div>
        <div class="field">
          <label>Optional SMTP Username</label>
          <input id="cfg-smtp-user" type="text" placeholder="you@gmail.com">
        </div>
        <div class="field">
          <label>Optional SMTP Password / App Password</label>
          <input id="cfg-smtp-pass" type="password" placeholder="Leave blank to keep existing">
        </div>
        <div class="field">
          <label>Admin Passcode (Optional; empty = localhost only)</label>
          <input id="cfg-admin-token" type="password" placeholder="Leave blank to keep existing">
        </div>
        <div class="field">
          <label>Auto-Reply to Visitor (When SMTP/Sendmail Active)</label>
          <select id="cfg-autoreply-enabled">
            <option value="false">Disabled</option>
            <option value="true">Enabled</option>
          </select>
        </div>
      </div>
      <div class="field" style="margin-top:.85rem;">
        <label>Auto-Reply Subject</label>
        <input id="cfg-autoreply-subject" type="text">
      </div>
      <div class="field" style="margin-top:.85rem;">
        <label>Auto-Reply Body</label>
        <textarea id="cfg-autoreply-msg" rows="3"></textarea>
      </div>
      <div style="display:flex;gap:.65rem;flex-wrap:wrap;margin-top:1rem;">
        <button type="button" class="btn btn-dark" id="btn-save-cfg">Save Settings</button>
        <button type="button" class="btn" id="btn-test-email">Send Test Email</button>
        <button type="button" class="btn btn-ghost" id="btn-clear-smtp-pass">Clear Saved SMTP Password</button>
      </div>
      <div id="cfg-status" class="status-note hidden"></div>
    </div>

    <div class="toolbar">
      <div class="tabs" id="status-tabs">
        <button type="button" class="tab active" data-filter="all">All</button>
        <button type="button" class="tab" data-filter="new">New</button>
        <button type="button" class="tab" data-filter="replied">Replied</button>
        <button type="button" class="tab" data-filter="archived">Archived</button>
      </div>
      <input id="search" type="search" placeholder="Search name, email, subject..." style="min-width:240px;">
    </div>

    <div id="list"><div class="empty">Loading…</div></div>
  </main>
  <script>
    (function () {
      var tokenInput = document.getElementById('token');
      var tokenPanel = document.getElementById('token-panel');
      var authMsg = document.getElementById('auth-msg');
      var settingsPanel = document.getElementById('settings-panel');
      var listEl = document.getElementById('list');
      var countEl = document.getElementById('count');
      var searchEl = document.getElementById('search');
      var cfgStatusEl = document.getElementById('cfg-status');

      var allRows = [];
      var activeFilter = 'all';
      var openIds = {};
      var replyDrafts = {};

      try {
        var saved = sessionStorage.getItem('gov_admin_token');
        if (saved) tokenInput.value = saved;
      } catch (e) {}

      function esc(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
      }

      function escAttr(s) {
        return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      function headers(extra) {
        var h = extra ? Object.assign({}, extra) : {};
        var tok = tokenInput.value.trim();
        if (tok) h['Authorization'] = 'Bearer ' + tok;
        return h;
      }

      function deliveryBadge(r) {
        var d = r.delivery || { status: 'stored-only', method: 'local-inbox' };
        if (d.status === 'delivered') return '<span class="badge b-ok">Delivered (' + esc(d.method || 'smtp') + ')</span>';
        if (d.status === 'pending') return '<span class="badge b-status">Delivering…</span>';
        if (d.status === 'failed') return '<span class="badge b-fail">Relay Failed (In Inbox)</span>';
        return '<span class="badge b-inbox">Self-Hosted Inbox</span>';
      }

      function buildReplyMailto(r) {
        var to = (r.data && r.data.email) ? r.data.email : '';
        var subj = 'Re: ' + (r.subject || 'Garden of Vee Enquiry');
        var body = 'Hello ' + ((r.data && r.data.name) || '') + ',\\r\\n\\r\\nThank you for reaching out to Garden of Vee.\\r\\n\\r\\n--- Original Message ---\\r\\n' + (r.body || '');
        return 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(body);
      }

      function renderDetail(r) {
        var d = r.data || {};
        var kv = '<dl class="kv">';
        var keys = Object.keys(d);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          kv += '<dt>' + esc(k) + '</dt><dd>' + esc(d[k] || '—') + '</dd>';
        }
        kv += '</dl>';

        var delivInfo = r.delivery && r.delivery.detail
          ? '<div class="status-note" style="margin-bottom:1rem;"><strong>Delivery Log:</strong> ' + esc(r.delivery.detail) + '</div>'
          : '';

        var repliesHtml = '';
        if (r.replies && r.replies.length) {
          repliesHtml = '<div class="replies-list"><strong>Reply History</strong>';
          for (var j = 0; j < r.replies.length; j++) {
            var rep = r.replies[j];
            repliesHtml +=
              '<div class="reply-item">' +
              '<div class="meta-line" style="margin-bottom:.3rem;"><strong>' + esc(rep.subject || 'Reply') + '</strong> · ' +
              esc(new Date(rep.sentAt).toLocaleString()) + ' · ' + esc(rep.deliveryDetail || 'Recorded') + '</div>' +
              '<div style="white-space:pre-wrap;">' + esc(rep.text) + '</div>' +
              '</div>';
          }
          repliesHtml += '</div>';
        }

        var draft = replyDrafts[r.id] || '';
        return (
          '<div class="detail">' +
          delivInfo +
          kv +
          '<div class="msg-box">' + esc(r.body || '') + '</div>' +
          '<div class="actions">' +
            '<a class="btn" href="' + escAttr(buildReplyMailto(r)) + '">Reply in Mail App</a>' +
            '<button type="button" class="btn btn-dark act-retry" data-id="' + escAttr(r.id) + '">Retry Email Delivery</button>' +
            '<button type="button" class="btn btn-ghost act-eml" data-id="' + escAttr(r.id) + '">Download .eml</button>' +
            '<button type="button" class="btn btn-ghost act-copy" data-id="' + escAttr(r.id) + '">Copy Text</button>' +
            '<button type="button" class="btn btn-ghost act-archive" data-id="' + escAttr(r.id) + '">' + (r.status === 'archived' ? 'Unarchive' : 'Archive') + '</button>' +
            '<button type="button" class="btn btn-danger act-del" data-id="' + escAttr(r.id) + '">Delete</button>' +
          '</div>' +
          '<div class="reply-box">' +
            '<strong style="font-size:.82rem;text-transform:uppercase;letter-spacing:.08em;">Send Direct Reply to ' + esc(d.email || 'Visitor') + '</strong>' +
            '<textarea class="reply-input" data-id="' + escAttr(r.id) + '" placeholder="Write your reply here...">' + esc(draft) + '</textarea>' +
            '<div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;">' +
              '<button type="button" class="btn act-send-reply" data-id="' + escAttr(r.id) + '">Send Reply</button>' +
              '<span class="meta-line reply-feedback" data-id="' + escAttr(r.id) + '"></span>' +
            '</div>' +
            repliesHtml +
          '</div>' +
          '</div>'
        );
      }

      function renderList() {
        var q = searchEl.value.trim().toLowerCase();
        var filtered = allRows.filter(function (r) {
          var st = r.status || (r.read ? 'read' : 'new');
          if (activeFilter === 'new' && st !== 'new') return false;
          if (activeFilter === 'replied' && st !== 'replied') return false;
          if (activeFilter === 'archived' && st !== 'archived') return false;
          if (activeFilter === 'all' && st === 'archived') return false;
          if (!q) return true;
          var hay = ((r.type || '') + ' ' + (r.subject || '') + ' ' + (r.body || '') + ' ' + JSON.stringify(r.data || {})).toLowerCase();
          return hay.indexOf(q) !== -1;
        });

        countEl.textContent = filtered.length + ' shown / ' + allRows.length + ' total';
        if (!filtered.length) {
          listEl.innerHTML = '<div class="empty">No matching submissions.</div>';
          return;
        }

        listEl.innerHTML = filtered.map(function (r) {
          var st = r.status || (r.read ? 'read' : 'new');
          var isUnread = st === 'new';
          var d = r.data || {};
          var isOpen = Boolean(openIds[r.id]);
          return (
            '<div class="row ' + (isUnread ? 'unread' : '') + '" data-id="' + escAttr(r.id) + '">' +
              '<div class="row-head">' +
                '<div>' +
                  '<div class="badges">' +
                    '<span class="badge b-type">' + esc(r.type || 'general') + '</span>' +
                    deliveryBadge(r) +
                    '<span class="badge b-status">' + esc(st) + '</span>' +
                  '</div>' +
                  '<div class="subj">' + esc(r.subject || 'Enquiry') + '</div>' +
                  '<div class="meta-line">' + esc(d.name || 'Visitor') + (d.email ? ' · ' + esc(d.email) : '') + (d.phone ? ' · ' + esc(d.phone) : '') + '</div>' +
                '</div>' +
                '<div class="when">' + esc(new Date(r.receivedAt).toLocaleString()) + '</div>' +
              '</div>' +
              (isOpen ? renderDetail(r) : '') +
            '</div>'
          );
        }).join('');

        bindRowEvents();
      }

      function bindRowEvents() {
        listEl.querySelectorAll('.row-head').forEach(function (head) {
          head.addEventListener('click', function () {
            var rowEl = head.closest('.row');
            var id = rowEl.getAttribute('data-id');
            openIds[id] = !openIds[id];
            if (openIds[id]) {
              var rec = allRows.find(function (x) { return x.id === id; });
              if (rec && (rec.status === 'new' || !rec.read)) {
                fetch('/api/submissions/' + encodeURIComponent(id), {
                  method: 'PATCH',
                  headers: headers({ 'Content-Type': 'application/json' }),
                  body: JSON.stringify({ read: true, status: 'read' }),
                }).then(function () {
                  rec.read = true;
                  if (rec.status === 'new') rec.status = 'read';
                  renderList();
                }).catch(function () {});
              }
            }
            renderList();
          });
        });

        listEl.querySelectorAll('.reply-input').forEach(function (ta) {
          ta.addEventListener('input', function () {
            replyDrafts[ta.getAttribute('data-id')] = ta.value;
          });
        });

        listEl.querySelectorAll('.act-retry').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            btn.disabled = true;
            btn.textContent = 'Delivering…';
            fetch('/api/submissions/' + encodeURIComponent(id) + '/retry', {
              method: 'POST',
              headers: headers(),
            })
              .then(function (r) { return r.json(); })
              .then(function () { load(true); })
              .catch(function () { btn.disabled = false; btn.textContent = 'Retry Email Delivery'; });
          });
        });

        listEl.querySelectorAll('.act-eml').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            fetch('/api/submissions/' + encodeURIComponent(id) + '/eml', { headers: headers() })
              .then(function (r) { return r.blob(); })
              .then(function (blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'gardenofvee-' + id + '.eml';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
              });
          });
        });

        listEl.querySelectorAll('.act-copy').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            var rec = allRows.find(function (x) { return x.id === id; });
            if (!rec) return;
            var txt = 'Subject: ' + (rec.subject || '') + '\\n\\n' + (rec.body || '');
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(txt);
            }
            btn.textContent = 'Copied!';
            setTimeout(function () { btn.textContent = 'Copy Text'; }, 1800);
          });
        });

        listEl.querySelectorAll('.act-archive').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            var rec = allRows.find(function (x) { return x.id === id; });
            var nextStatus = rec && rec.status === 'archived' ? 'read' : 'archived';
            fetch('/api/submissions/' + encodeURIComponent(id), {
              method: 'PATCH',
              headers: headers({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ status: nextStatus, read: true }),
            }).then(function () { load(true); });
          });
        });

        listEl.querySelectorAll('.act-del').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            if (!confirm('Delete this submission permanently?')) return;
            fetch('/api/submissions/' + encodeURIComponent(id), {
              method: 'DELETE',
              headers: headers(),
            }).then(function () { delete openIds[id]; load(true); });
          });
        });

        listEl.querySelectorAll('.act-send-reply').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            var text = (replyDrafts[id] || '').trim();
            var fb = listEl.querySelector('.reply-feedback[data-id="' + id + '"]');
            if (!text) { if (fb) fb.textContent = 'Please type a reply first.'; return; }
            btn.disabled = true;
            btn.textContent = 'Sending…';
            fetch('/api/submissions/' + encodeURIComponent(id) + '/reply', {
              method: 'POST',
              headers: headers({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ text: text }),
            })
              .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
              .then(function (res) {
                if (!res.ok) {
                  if (fb) fb.textContent = res.body.error || 'Failed to reply.';
                  btn.disabled = false;
                  btn.textContent = 'Send Reply';
                  return;
                }
                replyDrafts[id] = '';
                load(true);
              })
              .catch(function () {
                if (fb) fb.textContent = 'Network error while sending reply.';
                btn.disabled = false;
                btn.textContent = 'Send Reply';
              });
          });
        });
      }

      function load(silent) {
        if (!silent) listEl.innerHTML = '<div class="empty">Loading…</div>';
        fetch('/api/submissions', { headers: headers() })
          .then(function (res) {
            if (res.status === 401 || res.status === 403) {
              tokenPanel.classList.remove('hidden');
              return res.json().then(function (j) {
                authMsg.textContent = j.error || 'Enter access passcode above.';
                listEl.innerHTML = '<div class="empty">' + esc(j.error || 'Authentication required.') + '</div>';
                return null;
              });
            }
            tokenPanel.classList.add('hidden');
            try {
              var tok = tokenInput.value.trim();
              if (tok) sessionStorage.setItem('gov_admin_token', tok);
            } catch (e) {}
            return res.json();
          })
          .then(function (rows) {
            if (!rows) return;
            allRows = rows;
            renderList();
          })
          .catch(function () {
            if (!silent) listEl.innerHTML = '<div class="empty">Failed to load inbox.</div>';
          });
      }

      function loadConfig() {
        fetch('/api/admin/config', { headers: headers() })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (cfg) {
            if (!cfg) return;
            document.getElementById('cfg-recipient').value = cfg.recipientEmail || '';
            document.getElementById('cfg-from-name').value = cfg.fromName || '';
            document.getElementById('cfg-from-email').value = cfg.fromEmail || '';
            document.getElementById('cfg-mode').value = cfg.deliveryMode || 'auto';
            document.getElementById('cfg-smtp-host').value = (cfg.smtp && cfg.smtp.host) || '';
            document.getElementById('cfg-smtp-port').value = (cfg.smtp && cfg.smtp.port) || 587;
            document.getElementById('cfg-smtp-user').value = (cfg.smtp && cfg.smtp.user) || '';
            document.getElementById('cfg-smtp-pass').value = '';
            document.getElementById('cfg-smtp-pass').placeholder = (cfg.smtp && cfg.smtp.hasPassword) ? '•••••••• (saved)' : 'Optional SMTP / App Password';
            document.getElementById('cfg-admin-token').value = '';
            document.getElementById('cfg-admin-token').placeholder = cfg.hasAdminToken ? '•••••••• (passcode set)' : 'Empty = localhost only';
            document.getElementById('cfg-autoreply-enabled').value = (cfg.autoReply && cfg.autoReply.enabled) ? 'true' : 'false';
            document.getElementById('cfg-autoreply-subject').value = (cfg.autoReply && cfg.autoReply.subject) || '';
            document.getElementById('cfg-autoreply-msg').value = (cfg.autoReply && cfg.autoReply.message) || '';
            if (cfg.capabilities) {
              cfgStatusEl.classList.remove('hidden');
              cfgStatusEl.textContent = 'System check — Sendmail binary: ' + (cfg.capabilities.sendmailAvailable ? cfg.capabilities.sendmailPath : 'Not detected on host') + ' · SMTP configured: ' + (cfg.capabilities.smtpConfigured ? 'Yes' : 'No (using self-hosted inbox + direct/local fallback)');
            }
          });
      }

      document.getElementById('btn-unlock').addEventListener('click', function () { load(false); });
      tokenInput.addEventListener('keypress', function (e) { if (e.key === 'Enter') load(false); });
      document.getElementById('btn-refresh').addEventListener('click', function () { load(false); });
      document.getElementById('btn-settings').addEventListener('click', function () {
        settingsPanel.classList.toggle('hidden');
        if (!settingsPanel.classList.contains('hidden')) loadConfig();
      });
      document.getElementById('btn-close-settings').addEventListener('click', function () {
        settingsPanel.classList.add('hidden');
      });

      function saveConfig(clearPass) {
        var payload = {
          recipientEmail: document.getElementById('cfg-recipient').value.trim(),
          fromName: document.getElementById('cfg-from-name').value.trim(),
          fromEmail: document.getElementById('cfg-from-email').value.trim(),
          deliveryMode: document.getElementById('cfg-mode').value,
          smtp: {
            host: document.getElementById('cfg-smtp-host').value.trim(),
            port: Number(document.getElementById('cfg-smtp-port').value) || 587,
            user: document.getElementById('cfg-smtp-user').value.trim(),
          },
          autoReply: {
            enabled: document.getElementById('cfg-autoreply-enabled').value === 'true',
            subject: document.getElementById('cfg-autoreply-subject').value.trim(),
            message: document.getElementById('cfg-autoreply-msg').value,
          },
        };
        var passVal = document.getElementById('cfg-smtp-pass').value;
        if (passVal) payload.smtp.pass = passVal;
        if (clearPass) payload.clearSmtpPassword = true;
        var admVal = document.getElementById('cfg-admin-token').value;
        if (admVal) payload.adminToken = admVal;

        fetch('/api/admin/config', {
          method: 'PUT',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
          .then(function (res) {
            cfgStatusEl.classList.remove('hidden');
            cfgStatusEl.textContent = res.ok ? 'Settings saved to data/mail-config.json.' : (res.body.error || 'Failed to save.');
            if (res.ok && admVal) {
              tokenInput.value = admVal;
              try { sessionStorage.setItem('gov_admin_token', admVal); } catch (e) {}
            }
            if (res.ok) loadConfig();
          });
      }

      document.getElementById('btn-save-cfg').addEventListener('click', function () { saveConfig(false); });
      document.getElementById('btn-clear-smtp-pass').addEventListener('click', function () { saveConfig(true); });
      document.getElementById('btn-test-email').addEventListener('click', function () {
        cfgStatusEl.classList.remove('hidden');
        cfgStatusEl.textContent = 'Running email delivery test…';
        fetch('/api/admin/test-email', { method: 'POST', headers: headers() })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            cfgStatusEl.textContent = (res.delivered ? 'Success: ' : 'Notice: ') + (res.detail || res.error || JSON.stringify(res));
          })
          .catch(function () { cfgStatusEl.textContent = 'Test request failed.'; });
      });

      document.getElementById('status-tabs').querySelectorAll('.tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
          document.getElementById('status-tabs').querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
          tab.classList.add('active');
          activeFilter = tab.getAttribute('data-filter');
          renderList();
        });
      });

      searchEl.addEventListener('input', renderList);
      load(false);
      setInterval(function () { load(true); }, 30000);
    })();
  </script>
</body>
</html>`;

// ── Admin Routes ──────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
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

app.get('/api/submissions/:id/eml', requireAdmin, (req, res) => {
    const rec = readSubmissions().find((r) => r.id === req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    const config = getEffectiveConfig();
    const eml = buildRawEml(rec, config);
    res.setHeader('Content-Type', 'message/rfc822; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="gardenofvee-${sanitizeHeader(rec.id)}.eml"`);
    res.send(eml);
});

app.patch('/api/submissions/:id', requireAdmin, async (req, res) => {
    const allowedStatus = new Set(['new', 'read', 'replied', 'archived']);
    const { read, status } = req.body || {};
    const updated = await updateSubmission(req.params.id, (cur) => ({
        ...cur,
        ...(typeof read === 'boolean' ? { read } : {}),
        ...(typeof status === 'string' && allowedStatus.has(status) ? { status } : {}),
    }));
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
});

app.delete('/api/submissions/:id', requireAdmin, async (req, res) => {
    const removed = await deleteSubmission(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
});

app.post('/api/submissions/:id/retry', requireAdmin, async (req, res) => {
    const updated = await processSubmissionDelivery(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
});

app.post('/api/submissions/:id/reply', requireAdmin, async (req, res) => {
    const rec = readSubmissions().find((r) => r.id === req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });

    const text = cleanText(req.body?.text);
    if (!text) return res.status(400).json({ error: 'Reply text is required' });

    const visitorEmail = sanitizeEmail(rec.data?.email || '');
    if (!isValidEmail(visitorEmail)) {
        return res.status(400).json({ error: 'Submission does not contain a valid recipient email' });
    }

    const config = getEffectiveConfig();
    const subject = sanitizeHeader(req.body?.subject || `Re: ${rec.subject || 'Garden of Vee Enquiry'}`);
    const html = buildStyledHtmlEmail({
        pillarLabel: 'Garden of Vee · Reply',
        title: subject,
        rows: [
            ['To', visitorEmail],
            ['Reference ID', rec.id],
        ],
        noteLabel: 'Message',
        noteText: text,
    });

    const result = await deliverEmail(
        {
            fromName: config.fromName || 'Garden of Vee',
            fromEmail: config.fromEmail || DEFAULT_CONFIG.fromEmail,
            to: visitorEmail,
            replyTo: sanitizeEmail(config.recipientEmail || DEFAULT_CONFIG.recipientEmail),
            subject,
            text,
            html,
        },
        config
    );

    const replyEntry = {
        id: Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
        sentAt: new Date().toISOString(),
        to: visitorEmail,
        subject,
        text,
        delivered: Boolean(result.delivered),
        deliveryMethod: result.method,
        deliveryDetail: result.detail,
    };

    const updated = await updateSubmission(rec.id, (cur) => ({
        ...cur,
        read: true,
        status: 'replied',
        replies: [...(cur.replies || []), replyEntry],
    }));

    res.json({ success: true, delivery: result, submission: updated });
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
    const cfg = getEffectiveConfig();
    const sendmailPath = findSendmailPath();
    res.json({
        recipientEmail: cfg.recipientEmail,
        brandName: cfg.brandName,
        fromName: cfg.fromName,
        fromEmail: cfg.fromEmail,
        deliveryMode: cfg.deliveryMode,
        smtp: {
            host: cfg.smtp.host,
            port: cfg.smtp.port,
            secure: cfg.smtp.secure,
            user: cfg.smtp.user,
            hasPassword: Boolean(cfg.smtp.pass),
        },
        autoReply: cfg.autoReply,
        hasAdminToken: Boolean(cfg.adminToken),
        capabilities: {
            sendmailAvailable: Boolean(sendmailPath),
            sendmailPath,
            smtpConfigured: Boolean(cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass),
        },
    });
});

app.put('/api/admin/config', requireAdmin, (req, res) => {
    const current = readFileConfig();
    const body = req.body || {};

    if (body.recipientEmail && !isValidEmail(body.recipientEmail)) {
        return res.status(400).json({ error: 'Invalid recipient email address' });
    }
    if (body.fromEmail && !isValidEmail(body.fromEmail)) {
        return res.status(400).json({ error: 'Invalid sender email address' });
    }

    const portNum = Number(body.smtp?.port ?? current.smtp?.port ?? 587);
    const next = {
        recipientEmail: cleanText(body.recipientEmail ?? current.recipientEmail ?? DEFAULT_CONFIG.recipientEmail),
        brandName: cleanText(body.brandName ?? current.brandName ?? DEFAULT_CONFIG.brandName),
        fromName: cleanText(body.fromName ?? current.fromName ?? DEFAULT_CONFIG.fromName),
        fromEmail: cleanText(body.fromEmail ?? current.fromEmail ?? DEFAULT_CONFIG.fromEmail),
        deliveryMode: cleanText(body.deliveryMode ?? current.deliveryMode ?? DEFAULT_CONFIG.deliveryMode) || 'auto',
        smtp: {
            host: cleanText(body.smtp?.host ?? current.smtp?.host ?? ''),
            port: portNum,
            secure: portNum === 465,
            user: cleanText(body.smtp?.user ?? current.smtp?.user ?? ''),
            pass: body.clearSmtpPassword
                ? ''
                : body.smtp?.pass
                ? String(body.smtp.pass)
                : String(current.smtp?.pass || ''),
        },
        autoReply: {
            enabled:
                typeof body.autoReply?.enabled === 'boolean'
                    ? body.autoReply.enabled
                    : Boolean(current.autoReply?.enabled),
            subject: cleanText(body.autoReply?.subject ?? current.autoReply?.subject ?? DEFAULT_CONFIG.autoReply.subject),
            message: String(body.autoReply?.message ?? current.autoReply?.message ?? DEFAULT_CONFIG.autoReply.message),
        },
        adminToken: body.clearAdminToken
            ? ''
            : body.adminToken
            ? String(body.adminToken)
            : String(current.adminToken || ''),
    };

    writeFileConfig(next);
    res.json({ success: true });
});

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
    const config = getEffectiveConfig();
    const testText =
        `This is a diagnostic test email from your self-contained Garden of Vee server.\n\n` +
        `Timestamp: ${new Date().toISOString()}\n` +
        `Delivery Mode: ${config.deliveryMode}\n` +
        `Recipient: ${config.recipientEmail}\n`;
    const testHtml = buildStyledHtmlEmail({
        pillarLabel: 'Diagnostic Test',
        title: 'Garden of Vee Mail Delivery Test',
        rows: [
            ['Timestamp', new Date().toISOString()],
            ['Delivery Mode', config.deliveryMode],
            ['Recipient', config.recipientEmail],
        ],
        noteLabel: 'Status',
        noteText: 'Your self-contained Garden of Vee email server triggered this diagnostic test.',
    });

    const result = await deliverEmail(
        {
            fromName: config.fromName || 'Garden of Vee',
            fromEmail: config.fromEmail || DEFAULT_CONFIG.fromEmail,
            to: config.recipientEmail,
            subject: '[Garden of Vee] Diagnostic Test Email',
            text: testText,
            html: testHtml,
        },
        config
    );

    res.json(result);
});

// ── Public Enquiry & Contact Endpoints ────────────────────────────────────
app.post('/api/enquiry', async (req, res) => {
    const { type: rawType, formData: rawFormData } = req.body || {};
    const canonicalType = TYPE_ALIASES[String(rawType || '').trim().toLowerCase()];
    const formData = sanitizeFormData(rawFormData);

    if (!canonicalType) {
        return res.status(400).json({ error: 'Invalid or unsupported enquiry type' });
    }
    if (!formData.name || !formData.email) {
        return res.status(400).json({ error: 'Missing required fields: name and email are required' });
    }
    if (!isValidEmail(formData.email)) {
        return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (canonicalType === 'general' && !formData.message) {
        return res.status(400).json({ error: 'Please include your message' });
    }

    try {
        const config = getEffectiveConfig();
        const { subject, body, html } = buildEmail(canonicalType, formData);
        const record = {
            id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
            type: canonicalType,
            originalType: String(rawType),
            receivedAt: new Date().toISOString(),
            status: 'new',
            read: false,
            subject,
            body,
            html,
            data: formData,
            delivery: {
                status: config.deliveryMode === 'inbox-only' ? 'stored-only' : 'pending',
                method: config.deliveryMode === 'inbox-only' ? 'local-inbox' : null,
                lastAttemptAt: null,
                messageId: null,
                detail: config.deliveryMode === 'inbox-only' ? 'Saved to self-hosted inbox.' : 'Queued for delivery.',
                error: null,
            },
            replies: [],
        };

        await appendSubmission(record);

        // Respond immediately so visitor never waits on blocked ports; deliver in background
        if (config.deliveryMode !== 'inbox-only') {
            setImmediate(() => {
                processSubmissionDelivery(record.id).catch((err) => {
                    console.error('Background delivery error:', err.message);
                });
            });
        }

        res.json({
            success: true,
            message: 'Enquiry received',
            stored: true,
            id: record.id,
            receivedAt: record.receivedAt,
        });
    } catch (error) {
        console.error('Enquiry error:', error);
        res.status(500).json({ error: 'Failed to record enquiry', details: error.message });
    }
});

app.post('/api/contact', async (req, res) => {
    const formData = sanitizeFormData(req.body);
    const { name, email, message } = formData;

    if (!name || !email || !message) {
        return res.status(400).json({ error: 'Missing required fields: name, email, and message are required' });
    }
    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    try {
        const config = getEffectiveConfig();
        const { subject, body, html } = buildEmail('contact', formData);
        const record = {
            id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
            type: 'contact',
            originalType: 'contact',
            receivedAt: new Date().toISOString(),
            status: 'new',
            read: false,
            subject,
            body,
            html,
            data: formData,
            delivery: {
                status: config.deliveryMode === 'inbox-only' ? 'stored-only' : 'pending',
                method: config.deliveryMode === 'inbox-only' ? 'local-inbox' : null,
                lastAttemptAt: null,
                messageId: null,
                detail: config.deliveryMode === 'inbox-only' ? 'Saved to self-hosted inbox.' : 'Queued for delivery.',
                error: null,
            },
            replies: [],
        };

        await appendSubmission(record);

        if (config.deliveryMode !== 'inbox-only') {
            setImmediate(() => {
                processSubmissionDelivery(record.id).catch((err) => {
                    console.error('Background delivery error:', err.message);
                });
            });
        }

        res.json({
            success: true,
            message: 'Contact message received',
            stored: true,
            id: record.id,
            receivedAt: record.receivedAt,
        });
    } catch (error) {
        console.error('Contact error:', error);
        res.status(500).json({ error: 'Failed to record message', details: error.message });
    }
});

app.get('/api/health', (req, res) => {
    const cfg = getEffectiveConfig();
    const sendmailPath = findSendmailPath();
    const rows = readSubmissions();
    res.json({
        status: 'ok',
        selfContained: true,
        envRequired: false,
        deliveryMode: cfg.deliveryMode,
        smtpConfigured: Boolean(cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass),
        sendmailAvailable: Boolean(sendmailPath),
        inboxCount: rows.length,
    });
});

// ── Self-Contained Frontend & Static Asset Serving ────────────────────────
const distDir = path.join(ROOT_DIR, 'dist');
const hasDist = fs.existsSync(path.join(distDir, 'index.html'));
const publicRoot = hasDist ? distDir : ROOT_DIR;

const BLOCKED_PREFIXES = ['/data', '/node_modules'];
const BLOCKED_EXACT = new Set(['/server.js', '/package.json', '/package-lock.json', '/vite.config.ts', '/tsconfig.json']);
const BLOCKED_EXTS = new Set(['.jsonl', '.csv', '.ts', '.env', '.log', '.md']);
const SAFE_MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.mp4', '.webm', '.woff2', '.woff']);

app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    if (
        p.startsWith('/.') ||
        BLOCKED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + '/')) ||
        BLOCKED_EXACT.has(p) ||
        BLOCKED_EXTS.has(path.extname(p)) ||
        (!hasDist && p.endsWith('.js'))
    ) {
        return res.status(404).end();
    }
    next();
});

app.use(express.static(publicRoot));

if (hasDist) {
    app.use((req, res, next) => {
        if (SAFE_MEDIA_EXTS.has(path.extname(req.path).toLowerCase())) {
            return express.static(ROOT_DIR)(req, res, next);
        }
        next();
    });
}

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    const indexPath = path.join(publicRoot, 'index.html');
    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }
    res.status(404).send('index.html not found');
});

app.listen(port, () => {
    console.log(`Garden of Vee server running on http://localhost:${port}`);
    console.log(`Self-hosted inbox & mail settings: http://localhost:${port}/admin`);
    console.log(`Submissions stored in: ${DB_FILE}`);
});
```

---

### Updated `vite.config.ts`

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    hmr: process.env.DISABLE_HMR !== 'true',
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
      '/admin': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
```

---

### Updated `EnquiryModal` in `index.html`

Replace the `EnquiryModal` component in `index.html` (around lines 501–667) with the version below. It keeps all styling and copy intact while adding `<form>` Enter-key submission, email syntax validation, `400` vs offline/server error handling, CRLF `mailto:` line breaks, reference ID display, and a Copy-to-Clipboard fallback:

```jsx
        // ── ENQUIRY MODAL ────────────────────────────────────────────────
        const EnquiryModal = ({ modalState, onClose }) => {
            const type = modalState?.type || 'general';
            const preselected = modalState?.preselected || null;
            const cfg = ENQUIRY_CONFIG[type] || ENQUIRY_CONFIG['general'];
            const dark = cfg.dark;

            const [formData, setFormData] = useState({});
            const [submitted, setSubmitted] = useState(false);
            const [submissionResult, setSubmissionResult] = useState(null);
            const [sending, setSending] = useState(false);
            const [errors, setErrors] = useState({});
            const [serverError, setServerError] = useState('');
            const [formError, setFormError] = useState(false);
            const [copied, setCopied] = useState(false);

            useEffect(() => {
                const initial = {};
                if (preselected && cfg.preselectField) initial[cfg.preselectField] = preselected;
                setFormData(initial);
                setSubmitted(false);
                setSubmissionResult(null);
                setServerError('');
                setFormError(false);
                setCopied(false);
                setErrors({});
            }, [type, preselected]);

            useEffect(() => {
                const onKey = (e) => { if (e.key === 'Escape') onClose(); };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, [onClose]);

            const update = (id, val) => setFormData((p) => ({ ...p, [id]: val }));

            const buildMailtoHref = () => {
                const subject = encodeURIComponent(cfg.emailSubject(formData));
                const body = encodeURIComponent(cfg.emailBody(formData).replace(/\r?\n/g, '\r\n'));
                return `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
            };

            const copyEnquiryText = async () => {
                const fullText = `To: ${CONTACT_EMAIL}\nSubject: ${cfg.emailSubject(formData)}\n\n${cfg.emailBody(formData)}`;
                try {
                    if (navigator.clipboard?.writeText) {
                        await navigator.clipboard.writeText(fullText);
                    } else {
                        const ta = document.createElement('textarea');
                        ta.value = fullText;
                        ta.style.position = 'fixed';
                        ta.style.opacity = '0';
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        ta.remove();
                    }
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2500);
                } catch (err) {
                    console.error('Clipboard copy failed:', err);
                }
            };

            const handleSubmit = async (e) => {
                if (e?.preventDefault) e.preventDefault();
                const errs = {};
                cfg.fields.forEach((f) => {
                    const val = String(formData[f.id] || '').trim();
                    if (f.required && !val) {
                        errs[f.id] = 'This field is required';
                    } else if (f.type === 'email' && val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
                        errs[f.id] = 'Please enter a valid email address';
                    }
                });
                if (Object.keys(errs).length) { setErrors(errs); return; }

                setSending(true);
                setServerError('');
                setFormError(false);
                try {
                    const endpoint = IS_FILE_PROTOCOL ? 'http://localhost:3001/api/enquiry' : '/api/enquiry';
                    const res = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type, formData }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (res.status === 400) {
                        setServerError(data.error || 'Please check your details and try again.');
                        return;
                    }
                    if (!res.ok) throw new Error(data.error || 'Network response was not ok');
                    setSubmissionResult(data);
                    setSubmitted(true);
                } catch (err) {
                    console.error('Enquiry submission error:', err);
                    setFormError(true);
                } finally {
                    setSending(false);
                }
            };

            const inputBase = `w-full bg-transparent border-b py-3 text-sm font-light focus:outline-none transition-colors duration-300 ${
                dark
                    ? 'border-white/15 text-white placeholder-white/30 focus:border-white/60'
                    : 'border-gray-200 text-gray-800 placeholder-gray-400 focus:border-[#D16B3D]'
            }`;
            const labelBase = `block text-[10px] uppercase tracking-[0.35em] font-black mb-1 ${dark ? 'text-white/45' : 'text-gray-500'}`;
            const optionClass = dark ? 'bg-[#1a1a1a] text-white' : 'bg-white text-gray-800';

            return (
                <motion.div
                    key="modal-overlay"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                    className="fixed inset-0 z-[200] flex items-end md:items-center justify-center p-0 md:p-6"
                    style={{ backdropFilter: 'blur(12px)', backgroundColor: 'rgba(0,0,0,0.72)' }}
                    onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
                >
                    <motion.div
                        initial={{ opacity: 0, y: 60 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 60 }}
                        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                        className={`relative w-full md:max-w-[540px] rounded-t-[2.25rem] md:rounded-[2.5rem] shadow-2xl overflow-hidden ${dark ? 'bg-[#121212]' : 'bg-white'}`}
                        style={{ maxHeight: '90svh', overflowY: 'auto' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="absolute top-0 inset-x-0 h-1" style={{ background: `linear-gradient(90deg, transparent, ${cfg.accent}, transparent)` }} />

                        <button
                            type="button"
                            aria-label="Close enquiry modal"
                            onClick={onClose}
                            className={`absolute top-5 right-5 z-10 w-10 h-10 rounded-full flex items-center justify-center transition-all duration-300 ${
                                dark ? 'bg-white/10 hover:bg-white/20 text-white/70 hover:text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-500 hover:text-gray-900'
                            }`}
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>

                        <div className="px-6 sm:px-8 pt-10 pb-10 md:px-12 md:pt-12">
                            {formError ? (
                                <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-6">
                                    <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6" style={{ background: '#D16B3D18', border: '1px solid #D16B3D40' }}>
                                        <svg className="w-7 h-7" fill="none" stroke="#D16B3D" strokeWidth="1.6" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                        </svg>
                                    </div>
                                    <h3 className={`font-display text-2xl md:text-3xl font-medium mb-3 ${dark ? 'text-white' : 'text-gray-800'}`}>
                                        Complete via Email App
                                    </h3>
                                    <p className={`text-sm font-light leading-relaxed max-w-sm mx-auto mb-7 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>
                                        The server relay is currently unavailable. Click below to open your pre-filled enquiry directly in your email app or copy it to your clipboard.
                                    </p>
                                    <div className="flex flex-col sm:flex-row gap-3 justify-center items-center flex-wrap">
                                        <a href={buildMailtoHref()} className="px-7 py-3.5 rounded-full text-white text-[11px] uppercase tracking-[0.25em] font-black shadow-lg" style={{ background: cfg.accent }}>
                                            Open Email App
                                        </a>
                                        <button type="button" onClick={copyEnquiryText} className={`px-6 py-3.5 rounded-full border text-[11px] uppercase tracking-[0.22em] font-bold transition-colors ${dark ? 'border-white/20 text-white/85 hover:border-white/50' : 'border-gray-300 text-gray-700 hover:border-gray-500'}`}>
                                            {copied ? 'Copied!' : 'Copy Email Text'}
                                        </button>
                                        <button type="button" onClick={() => setFormError(false)} className={`text-[11px] uppercase tracking-[0.25em] font-bold px-5 py-3 ${dark ? 'text-white/60 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`}>
                                            Retry Form
                                        </button>
                                    </div>
                                </motion.div>
                            ) : submitted ? (
                                <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-6">
                                    <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6" style={{ background: `${cfg.accent}18`, border: `1px solid ${cfg.accent}40` }}>
                                        <svg className="w-7 h-7" fill="none" stroke={cfg.accent} strokeWidth="1.8" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                        </svg>
                                    </div>
                                    <h3 className={`font-display text-2xl md:text-3xl font-medium mb-3 ${dark ? 'text-white' : 'text-gray-800'}`}>
                                        Your enquiry has been sent
                                    </h3>
                                    <p className={`text-sm font-light leading-relaxed max-w-xs mx-auto mb-4 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>
                                        Thank you, {formData.name}. Garden of Vee has received your enquiry and will respond within 24 hours.
                                    </p>
                                    {submissionResult?.id && (
                                        <p className={`text-[11px] tracking-wider uppercase mb-6 ${dark ? 'text-white/40' : 'text-gray-400'}`}>
                                            Reference: {submissionResult.id}
                                        </p>
                                    )}
                                    <div className="flex flex-col items-center gap-3">
                                        <button type="button" onClick={onClose} className="text-[11px] uppercase tracking-[0.3em] font-black" style={{ color: cfg.accent }}>
                                            Close Window
                                        </button>
                                        <a href={buildMailtoHref()} className={`text-[11px] underline underline-offset-4 transition-opacity hover:opacity-80 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>
                                            Also open a copy in your email app
                                        </a>
                                    </div>
                                </motion.div>
                            ) : (
                                <form onSubmit={handleSubmit} noValidate>
                                    <div className="mb-8 pr-8">
                                        <span className="text-[10px] uppercase tracking-[0.4em] font-black mb-2.5 block" style={{ color: cfg.accent }}>
                                            {cfg.label}
                                        </span>
                                        <h2 className={`font-display text-2xl md:text-3xl font-medium tracking-tight mb-2.5 leading-tight ${dark ? 'text-white' : 'text-gray-800'}`}>
                                            {cfg.title}
                                        </h2>
                                        <p className={`text-sm font-light leading-relaxed ${dark ? 'text-gray-400' : 'text-gray-500'}`}>
                                            {cfg.subtitle}
                                        </p>
                                        {preselected && (
                                            <div className="mt-4 inline-flex items-center px-3.5 py-1.5 rounded-full text-[11px] font-semibold tracking-wide"
                                                style={{ background: `${cfg.accent}1a`, color: cfg.accent, border: `1px solid ${cfg.accent}33` }}>
                                                Selected: {preselected}
                                            </div>
                                        )}
                                    </div>

                                    {serverError && (
                                        <div className="mb-6 px-4 py-3 rounded-xl text-xs font-medium" style={{ background: `${cfg.accent}18`, color: cfg.accent, border: `1px solid ${cfg.accent}40` }}>
                                            {serverError}
                                        </div>
                                    )}

                                    <div className="space-y-6">
                                        {cfg.fields.map((field) => (
                                            <div key={field.id}>
                                                <label className={labelBase}>
                                                    {field.label}
                                                    {field.required && <span style={{ color: cfg.accent }}> *</span>}
                                                </label>
                                                {field.type === 'textarea' ? (
                                                    <textarea
                                                        rows={3}
                                                        placeholder={field.placeholder || ''}
                                                        className={inputBase + ' resize-none'}
                                                        value={formData[field.id] || ''}
                                                        onChange={(e) => { update(field.id, e.target.value); setErrors((p) => ({ ...p, [field.id]: '' })); }}
                                                    />
                                                ) : field.type === 'select' ? (
                                                    <select
                                                        className={inputBase + ' cursor-pointer'}
                                                        value={formData[field.id] || ''}
                                                        onChange={(e) => { update(field.id, e.target.value); setErrors((p) => ({ ...p, [field.id]: '' })); }}
                                                    >
                                                        <option value="" className={optionClass}>Select an option</option>
                                                        {field.options.map((o) => <option key={o} value={o} className={optionClass}>{o}</option>)}
                                                    </select>
                                                ) : (
                                                    <input
                                                        type={field.type}
                                                        placeholder={field.placeholder || ''}
                                                        className={inputBase}
                                                        value={formData[field.id] || ''}
                                                        onChange={(e) => { update(field.id, e.target.value); setErrors((p) => ({ ...p, [field.id]: '' })); }}
                                                    />
                                                )}
                                                {errors[field.id] && <p className="text-[11px] mt-1.5 font-medium" style={{ color: cfg.accent }}>{errors[field.id]}</p>}
                                            </div>
                                        ))}
                                    </div>

                                    <div className="mt-9 space-y-3">
                                        <motion.button
                                            type="submit"
                                            disabled={sending}
                                            whileHover={{ scale: 1.015 }}
                                            whileTap={{ scale: 0.98 }}
                                            className="w-full py-4 rounded-full text-white text-[11px] uppercase tracking-[0.28em] font-black shadow-lg disabled:opacity-60"
                                            style={{ background: `linear-gradient(130deg, ${cfg.accent}, #c9975b 75%, ${cfg.accent})` }}
                                        >
                                            {sending ? 'Sending...' : 'Send Enquiry'}
                                        </motion.button>
                                        <div className="text-center pt-1">
                                            <a href={buildMailtoHref()} className={`inline-block text-[11px] underline underline-offset-4 transition-opacity hover:opacity-80 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>
                                                Or open pre-filled email in your mail app
                                            </a>
                                        </div>
                                    </div>
                                </form>
                            )}
                        </div>
                    </motion.div>
                </motion.div>
            );
        };
