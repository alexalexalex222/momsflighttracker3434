# Flight Tracker - Context for Codex

## Project Overview
Christmas 2025 gift for Mom - flight price tracker that runs entirely via web UI.
Mom opens a webpage, adds flights to track, and gets automatic email updates every 6 hours.

## Live URL
https://web-production-10038.up.railway.app/

## Current Issue
Adding flights via form shows generic "Error" alert. App works locally on Mac, fails on Railway (Linux).

## Environment Variables (Railway)
- `RESEND_API_KEY` = `re_G8GSxLer_CzUi1dZ817u6zzaP1BkxsJ5v`
- `PUPPETEER_EXECUTABLE_PATH` = `chromium` (set via nixpacks.toml)

## Features
1. **Track Flights** - Add flights via web form (stored in SQLite)
2. **Automatic Price Checks** - Every 6 hours via node-cron
3. **Email Notifications** - Via Resend API
4. **Delta Priority** - Prefers Delta prices over cheapest
5. **Price Intelligence** - AI analysis with web search for insights
6. **Puppeteer Scraper** - Scrapes Google Flights

## Tech Stack
- Express.js server
- SQLite via better-sqlite3 (native module)
- Puppeteer + Stealth plugin
- Resend for emails
- node-cron for scheduling
- Railway hosting with nixpacks

## File Structure
```
src/
├── web/
│   ├── server.js          # Express API
│   └── public/index.html  # Frontend UI
├── db/
│   ├── setup.js           # SQLite init + migrations
│   ├── flights.js         # Database queries
│   └── schema.sql         # Table definitions
├── scraper/
│   └── google-flights.js  # Puppeteer scraper
├── scheduler/
│   └── alerts.js          # 6-hour cron job
├── notifications/
│   └── email.js           # Resend email sending
└── agent/
    └── analyze.js         # Price intelligence
```

## Context Files (Full Code)
- `02-server.js.txt` - Express server with all routes
- `03-setup.js.txt` - Database setup with fallback logic
- `04-flights.js.txt` - Database query functions
- `05-schema.sql.txt` - SQLite schema
- `06-google-flights.js.txt` - Puppeteer scraper with browser detection
- `07-alerts.js.txt` - Scheduler
- `08-email.js.txt` - Email sending
- `09-analyze.js.txt` - Price intelligence
- `10-config.txt` - package.json + nixpacks.toml
