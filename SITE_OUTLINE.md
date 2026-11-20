# Garden of Vee - Website Outline

## Overview

**Domain:** gardenofvee.africa  
**Tagline:** Breathe · Belong · Become  
**Core Philosophy:** Creating spaces for shared presence, creative expression, and spiritual reflection

---

## Design System

### Color Palette
| Variable | Color | Usage |
|----------|-------|-------|
| `--clay` | #D16B3D | Primary accent, CTA buttons |
| `--clay-light` | #e88a5e | Hover states |
| `--clay-dark` | #a84d28 | Dark variants |
| `--sage` | #717254 | Secondary accent |
| `--sage-light` | #8f906e | Highlights |
| `--sage-dark` | #55563b | Text on dark backgrounds |
| `--warm-bg` | #fcfbf9 | Page background |
| `--deep` | #1a1a1a | Dark backgrounds |
| `--golden` | #c9975b | Gradient accent |
| `--cream` | #faf7f2 | Light backgrounds |
| `--olive` | #5a5e3d | Team page accent |
| `--terracotta` | #b85c3a | Organic accent |

### Typography
- **Primary Font:** Inter (Headings, body text, UI)
  - Weights: 200-900, full range available
- **Display Font:** Playfair Display (Headings with personality)
  - Used for page titles and special headings

### Spacing System (Fluid)
- `--space-sm`: clamp(1rem, 3vw, 1.5rem)
- `--space-md`: clamp(2rem, 5vw, 4rem)
- `--space-lg`: clamp(4rem, 8vw, 8rem)
- `--space-xl`: clamp(5rem, 10vw, 10rem)

### UI Patterns
- **Glass Morphism:** Frosted glass effect for cards and nav
- **Subtle Animations:** Framer Motion powered micro-interactions
- **Marquee:** Parallax-like scrolling text strips
- **Grain Overlay:** Subtle film grain texture
- **Spotlight Cards:** Hover reveal with radial gradient

---

## Site Architecture

### 1. Home Page (`/`)
**Hero Section:**
- Full-screen video background
- Logo display
- Tagline animation: "Breathe · Belong · Become"
- CTA: "Explore experiences" button / "Make an Enquiry"

**Pillars Section:**
1. **The Gather Experience** - Community focus
2. **The Retreat Experience** - Rest and renewal
3. **Faith & Wellness** - Spiritual reflection

**Experiences Preview:**
- Interactive grid of 4 service cards
- Hover: scale and reveal description
- Cards: Shared Moments, Retreats, Faith, Team

**Social Section:**
- Instagram feed card
- Facebook link card
- Follow buttons visual

**Enquiry Cards:**
- 5 service cards in dark theme
  - Community (Shared Moments)
  - Sanctuary (Retreats)
  - Spirituality (Faith)
  - Leadership (Team)

**Contact Section:**
- Phone: 078 514 7472
- Email: "Send us a message" (opens enquiry modal)

**Footer:**
- Logo
- Tagline description
- Social links (Email, Instagram, Facebook)
- Back to top

---

### 2. Shared Moments Page (`/shared-moments`)
**Hero:**
- Page header: "Shared Moments"
- Subheading about community experiences
- Featured video

**Experience Categories:**
1. **Creative Events**
   - Sip & Paint
   - Poetry Events
   - Slow Craft Events

2. **Creative Moments**
   - Outdoor Movie Nights
   - Listening Sessions
   - Neo-Soul Events
   - Music Live Events

3. **Shared Time**
   - Catered Events
   - Dining Events
   - Bonfire Evenings

**CTA:** "Reserve a Spot" button

---

### 3. Retreats Page (`/retreats`)
**Hero:**
- Page header: "Retreats"
- Subheading about rest and renewal
- Split layout: image/video + text

**Retreat Types:**
1. **Solo Retreats** - Personal quietude, no performance
2. **Couples Retreats** - Connection and intimacy
3. **Youth Camps** - Adventure, faith, community
4. **Reflection Retreats** - Scripture, journaling, prayer

**CTA:** "Book a Retreat" button

---

### 4. Faith & Reflection Page (`/faith`)
**Hero:**
- Page header: "Faith & Reflection"
- Background image with subtle particles

**Gatherings:**
1. Scripture Reflection
2. Prayer Evenings
3. Bible Study
4. Praise & Worship Events

**Core Statement:**
> "Biblically grounded gatherings centred on Christian doctrine with Bible-based scripture. Open to believers and seekers alike."

**CTA:** "Join a Gathering" button

---

### 5. Team & Culture Page (`/team`)
**Hero:**
- Page header: "Team & Culture"
- Subheading about facilitated team experiences

**Focus Areas:**
1. **Alignment** - Vision, values, and goals
2. **Leadership** - Emotional intelligence and communication
3. **Wellbeing** - Burnout prevention and support

**Background Image:** Team experience visual

**CTA:** "Book a Team Experience" button

---

## Interaction Design

### Navigation
- **Desktop:** Horizontal links + GlowButton "Enquire"
- **Mobile:** Hamburger menu with slide-down panel
- **Scroll Effect:** Glass background appears on scroll
- **Logo:** Click returns to home

### Modal Enquiry System
**Trigger Events:**
- "Make an Enquiry" button (hero, nav, footer, contact section)
- Individual experience cards
- Phone email link

**Modal Structure:**
```
Close Button (X)
Accent Header Strip
Type Label (Community/Sanctuary/Spirituality/Leadership/Get in Touch)
Title
Subtitle
Form Fields
Submit Button
```

### Form Fields by Type

| Type | Config Key | Fields |
|------|------------|--------|
| Shared Moments | `shared-moments` | name, email, event, groupSize, dates, message |
| Retreats | `retreats` | name, email, retreatType, attendees, dates, requirements |
| Faith | `faith` | name, email, gatheringType, firstTime, message |
| Team | `team` | name, email, organisation, teamSize, focusArea, format, message |
| General | `general` | name, email, subject, message |

### Animations
- **Reveal Section:** Fade up on scroll into view
- **Stagger Container:** Children animate in sequence
- **Card Hover:** 3D lift with shadow
- **Button Magnetic:** Text pull on mouse move
- **Hero Text:** Staggered appearance with blur-in effect

---

## Technical Architecture

### Frontend
- **Framework:** React (via CDN, no build step required)
- **Bundling:** Vite with vanilla HTML entry
- **Styling:** Tailwind CSS + custom CSS variables
- **Animation:** Framer Motion 10.x
- **Icons:** Inline SVG from Heroicons

### Backend (Self-hosted Inbox)
- **Server:** Express.js (server.js)
- **Submission store:** Local JSON Lines file (`data/submissions.jsonl`) — every form submission is persisted locally with no external email service required
- **Admin inbox:** Self-hosted UI at `/admin` and API at `/api/submissions` to read stored submissions (localhost-only by default, or token-protected via `SUBMISSIONS_TOKEN`)
- **Optional relay:** If `SMTP_USER`/`SMTP_PASS` are set, submissions are *additionally* emailed via STARTTLS (fully optional)
- **Security:** Input sanitization, env secrets, optional admin bearer token, CORS origin restriction
- **API Endpoints:**
  - `POST /api/enquiry` - Form submissions (stored locally, optional SMTP relay)
  - `POST /api/contact` - Contact form (stored locally, optional SMTP relay)
  - `GET /api/submissions` - List submissions (admin, auth-gated)
  - `GET /api/submissions/:id` - Single submission (admin, auth-gated)
  - `GET /admin` - Self-hosted inbox UI (admin, auth-gated)
  - `GET /api/health` - Health check (`{ status, smtp }`)

### Environment Variables
```
# Self-hosted inbox (no external email service required)
SUBMISSIONS_TOKEN=""          # optional: Bearer token for /admin + /api/submissions; localhost-only when empty
#
# Optional SMTP relay (leave empty to stay fully self-hosted)
SMTP_HOST="smtp.your-mail-server.com"
SMTP_PORT="587"
SMTP_USER=""
SMTP_PASS=""
SMTP_TO="contact@your-domain.com"
#
PORT=3001
APP_URL=https://gardenofvee.africa
```

### Development Setup
```bash
# Terminal 1: Frontend dev server
npm run dev

# Terminal 2: Backend server
npm run dev:server
# Or: node server.js
```

---

## Content Strategy

### Voice & Tone
- **Warm** - Inviting and welcoming language
- **Authentic** - Real, grounded expressions
- **Inclusive** - Welcomes all backgrounds and faith journeys
- **Gentle** - No pressure, only invitation

### Key Messages
1. "All are welcome"
2. "No performance expected"
3. "Spaces for rest and reflection"
4. "Community through shared presence"
5. "Faith rooted, open to all seekers"

### Visual Content
- **Videos:** Hero backgrounds, experience previews
- **Images:** Event photography, retreat locations
- **Social Proof:** Instagram grid integration

---

## Forms & Data Flow

### Submission Flow
1. User fills form → Client-side validation
2. POST to `/api/enquiry` (or `/api/contact`)
3. Server validates fields, builds a typed email template, and appends the submission to `data/submissions.jsonl`
4. If SMTP relay credentials are configured → additionally email a copy over STARTTLS with `reply-to` set to the user (fully optional)
5. Success response → Show confirmation modal (submission is stored locally regardless of SMTP)

### Error Handling
- Validation errors shown inline on form fields
- Network/form errors shown in error state modal with retry option
- Submissions are always stored locally before any optional relay, so a mailer outage never loses a submission

### Security Measures
- **Local-first storage:** submissions persisted to disk with no third-party email dependency by default
- **Input Sanitization:** backend strips line breaks from subject lines (header-injection prevention)
- **Environment Secrets:** SMTP credentials never in code; admin token optional
- **Admin auth gate:** `/admin` and `/api/submissions*` restricted to localhost, or a bearer token when `SUBMISSIONS_TOKEN` is set
- **CORS Protection:** Origin-restricted API calls

---

## Media Assets

| File | Purpose | Location |
|------|---------|----------|
| favi.png | Logo/favicon | `public/` (served at `/favi.png`) |
| ggh.png | Hero logo | `public/` (served at `/ggh.png`) |
| moments.mp4 | Shared Moments preview | `public/` (served at `/moments.mp4`) |
| retreats.mp4 | Retreats preview | `public/` (served at `/retreats.mp4`) |

---

## SEO & Metadata

**Title:** Garden of Vee | Breathe · Belong · Become  
**Description:** Creating spaces for shared presence, creative expression, and spiritual reflection. Community experiences, retreats, faith gatherings, and team culture events.

**Open Graph:**
- Images from /assets
- Brand colors: #D16B3D (clay), #717254 (sage)

---

## Deployment Notes

### Production Build
```bash
npm run build
# Output: dist/
```

### Multi-Environment Setup
- **Development:** Vite dev server (port 3000) + Express server (port 3001). The Vite dev server proxies `/api` to the backend.
- **Production:** Vite preview (serves `dist/`) + Nginx reverse proxy forwarding `/api` and `/admin` to the Express backend. Nginx must fall back to `index.html` for SPA routes.

### Environment Configuration
- Copy `.env.example` to `.env`
- The site works fully self-hosted with no SMTP settings (submissions are stored locally and readable via `/admin`)
- To also email copies of submissions, fill in the optional `SMTP_*` fields
- Set `APP_URL` for production (CORS) and optionally `SUBMISSIONS_TOKEN` to protect the admin inbox when exposed publicly

---

## Dependencies

### Production
```
express@^4.21.0
nodemailer@^6.9.15
cors@^2.8.5
dotenv@^16.4.7
```

### Build/Dev
```
vite@^6.2.0
tailwindcss@^4.1.14
typescript@~5.8.2
tsx@^4.21.0
```

---

## File Structure

```
garden-of-vee/
├── index.html           # Main page (single file app with React)
├── server.js            # Express backend (self-hosted inbox + optional SMTP relay)
├── vite.config.ts       # Vite config with API proxy
├── package.json         # Dependencies and scripts
├── .env.example         # Environment template (self-hosted by default)
├── .gitignore
├── README.md
├── SITE_OUTLINE.md     # This document
├── public/             # Static media (copied to dist/ root by Vite)
│   ├── favi.png        # Logo/favicon
│   ├── ggh.png         # Hero logo
│   ├── moments.mp4     # Shared Moments video
│   └── retreats.mp4    # Retreats video
└── data/               # Local submission store (created at runtime, gitignored)
    └── submissions.jsonl
```