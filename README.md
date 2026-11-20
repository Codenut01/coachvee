# Garden of Vee

**Breathe · Belong · Become**

A single-file React + Vite website for Garden of Vee, a wellness and faith-rooted
community platform offering creative events, retreats, faith gatherings, and
team culture experiences.

- **Frontend:** React 18 (CDN), Framer Motion, Tailwind CSS + custom CSS variables
- **Bundling:** Vite
- **Backend (email):** Express.js + Nodemailer over STARTTLS
- **Domain:** gardenofvee.africa

## Development

```bash
# Terminal 1 — frontend dev server (http://localhost:3000)
npm run dev

# Terminal 2 — backend email/API server (http://localhost:3001)
npm run dev:server
```

The Vite dev server proxies `/api` requests to the Express backend.

## Production

```bash
npm run build      # → dist/
npm start          # vite preview (serves dist/)
npm run server     # node server.js (API on PORT, default 3001)
```

In production the API is reverse-proxied to the Express backend (e.g. via Nginx
serving `/api/...` to `http://localhost:3001`).

The site is a client-side SPA: Vite serves `index.html` for every route and the
React app syncs the URL with `history.pushState`, so pages (`/shared-moments`,
`/retreats`, `/faith`, `/team`) are bookmarkable and the back button works. For
deep links the server must fall back to `index.html`. Example Nginx config:

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
location /api/ {
    proxy_pass http://localhost:3001;
}
```

## Environment

Copy the example and fill in your SMTP credentials (Gmail App Password recommended).

```bash
cp .env.example .env
```

| Variable    | Description                                  |
| ----------- | -------------------------------------------- |
| `SMTP_HOST` | SMTP server (default `smtp.gmail.com`)       |
| `SMTP_PORT` | SMTP port (default `587`)                    |
| `SMTP_USER` | Sender email address                         |
| `SMTP_PASS` | App password / SMTP password                 |
| `SMTP_TO`   | Recipient (default `Gardenofvee.info@gmail.com`)|
| `PORT`      | Backend port (default `3001`)                |
| `APP_URL`   | Site URL, used for CORS origin               |

## Project Layout

```
garden-of-vee/
├── index.html           # Single-file React app (CDN)
├── public/              # Static media (favicon, logo, videos) → copied to dist
├── server.js            # Express backend for email submissions
├── vite.config.ts       # Vite dev server + /api proxy
├── package.json
├── .env.example
└── dist/                # Production build output
```
