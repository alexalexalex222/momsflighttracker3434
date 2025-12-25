# Flight Tracker

An agentic flight price tracker that uses Claude + browser automation to monitor Google Flights prices.

**Made with love for Mom - Christmas 2025**

## Features

- Track multiple flights to any destination
- Automatic price checks every 4 hours
- Email notifications when prices drop
- AI-powered "best time to buy" recommendations
- Beautiful web dashboard to manage flights

## Quick Start

```bash
# Install dependencies
npm install

# Set up the database
npm run setup

# Start the web UI
npm run dev

# Open http://localhost:3000
```

## Usage

### Add a Flight

1. Open http://localhost:3000
2. Fill in the flight details (origin, destination, dates)
3. Add your email for notifications
4. Click "Start Tracking"

### Manual Price Check

```bash
npm run scrape
```

### Get AI Analysis

```bash
npm run analyze
```

## Automated Checks

To enable automatic checking every 4 hours:

```bash
./scripts/install-scheduler.sh
```

This installs a macOS launchd job that runs whenever your computer is awake.

## Environment Variables

Create a `.env` file:

```
RESEND_API_KEY=re_xxxxx  # For email notifications
```

### Railway Deployment Notes

- `data/` and `flights.db` are intentionally gitignored, so production needs to create the SQLite DB at runtime.
- Set `RESEND_API_KEY` in Railway service variables (don’t commit it).
- If you want the DB to survive redeploys/restarts, attach a Railway Volume and set `DB_PATH` to a path inside that volume.
- If you’re using Chromium via Nixpacks `nixPkgs = ["chromium", ...]`, set `PUPPETEER_EXECUTABLE_PATH=chromium` (don’t use `/usr/bin/chromium-browser`, it’s often a snap stub).

## Project Structure

```
flight-tracker/
├── data/
│   └── flights.db          # SQLite database
├── src/
│   ├── agent/
│   │   ├── scrape-prompt.md   # Instructions for Claude scraper
│   │   ├── analyze-prompt.md  # Instructions for price analysis
│   │   └── analyze.js         # Analysis script
│   ├── db/
│   │   ├── schema.sql         # Database schema
│   │   ├── setup.js           # DB initialization
│   │   └── flights.js         # DB operations
│   ├── notifications/
│   │   └── email.js           # Resend email integration
│   └── web/
│       ├── server.js          # Express server
│       └── public/
│           └── index.html     # Web dashboard
├── scripts/
│   ├── run-scrape.sh          # Scrape runner script
│   ├── install-scheduler.sh   # Install launchd job
│   └── com.flighttracker.scrape.plist
└── package.json
```

## How It Works

1. **Web UI** - Mom adds flights she wants to track
2. **Scheduler** - Every 4 hours (when Mac is awake), launchd triggers a scrape
3. **Claude Agent** - Claude with chrome automation opens Google Flights and extracts prices
4. **Database** - Prices are stored with timestamps for trend analysis
5. **Notifications** - If price drops >10%, email notification is sent
6. **Analysis** - On-demand AI analysis recommends when to buy

## License

Made with ❤️ by Alex for Mom
