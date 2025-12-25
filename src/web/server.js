import 'dotenv/config';
import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    getActiveFlights,
    addFlight,
    getFlightWithPrices,
    getAllFlightsWithLatestPrice,
    deactivateFlight,
    getPriceHistory
} from '../db/flights.js';
import { getDb, getDbPath } from '../db/setup.js';
import { startScheduler } from '../scheduler/alerts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isValidAirportCode(value) {
    if (!isNonEmptyString(value)) return false;
    return /^[A-Za-z]{3}$/.test(value.trim());
}

function isValidIsoDate(value) {
    if (!isNonEmptyString(value)) return false;
    // Expect YYYY-MM-DD (what <input type="date"> produces)
    return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function isValidEmail(value) {
    if (!isNonEmptyString(value)) return false;
    // Pragmatic validation; we just need "something@something.tld"
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// Ensure the SQLite file + schema exists at boot (helpful for Railway logs).
try {
    const db = getDb();
    db.close();
} catch (error) {
    console.error('[DB] Initialization failed:', error);
}

// API Routes
app.get('/api/health', (req, res) => {
    let dbOk = true;
    let dbError = null;

    try {
        const db = getDb();
        db.prepare('SELECT 1').get();
        db.close();
    } catch (e) {
        dbOk = false;
        dbError = e?.message || String(e);
    }

    res.json({
        ok: dbOk,
        timestamp: new Date().toISOString(),
        node: process.version,
        db: {
            ok: dbOk,
            path: getDbPath(),
            error: dbError
        },
        email: {
            resendConfigured: Boolean(process.env.RESEND_API_KEY)
        },
        build: {
            railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
            vercelCommit: process.env.VERCEL_GIT_COMMIT_SHA || null,
            githubSha: process.env.GITHUB_SHA || null
        }
    });
});

app.get('/api/flights', (req, res) => {
    try {
        const flights = getAllFlightsWithLatestPrice();
        res.json(flights);
    } catch (error) {
        console.error('[API] GET /api/flights failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/flights', (req, res) => {
    try {
        const body = req.body || {};
        const errors = [];

        if (!isNonEmptyString(body.name)) errors.push('Trip Name is required');
        if (!isValidAirportCode(body.origin)) errors.push('From must be a 3-letter airport code (ex: ATL)');
        if (!isValidAirportCode(body.destination)) errors.push('To must be a 3-letter airport code (ex: SFO)');
        if (!isValidIsoDate(body.departure_date)) errors.push('Departure date is required');
        if (body.return_date && !isValidIsoDate(body.return_date)) errors.push('Return date must be a valid date');
        if (body.passengers && (!Number.isFinite(body.passengers) || body.passengers < 1 || body.passengers > 9)) {
            errors.push('Travelers must be between 1 and 9');
        }
        if (body.notify_email && !isValidEmail(body.notify_email)) errors.push('Email must be valid');

        if (errors.length) {
            return res.status(400).json({ error: errors.join('. ') });
        }

        const id = addFlight(body);
        res.json({ id, success: true });
    } catch (error) {
        console.error('[API] POST /api/flights failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/flights/:id', (req, res) => {
    try {
        const flight = getFlightWithPrices(parseInt(req.params.id));
        res.json(flight);
    } catch (error) {
        console.error('[API] GET /api/flights/:id failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/flights/:id/prices', (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const prices = getPriceHistory(parseInt(req.params.id), days);
        res.json(prices);
    } catch (error) {
        console.error('[API] GET /api/flights/:id/prices failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/flights/:id', (req, res) => {
    try {
        deactivateFlight(parseInt(req.params.id));
        res.json({ success: true });
    } catch (error) {
        console.error('[API] DELETE /api/flights/:id failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get analysis for a flight
app.get('/api/flights/:id/analysis', async (req, res) => {
    try {
        const { analyzeFlightPrice } = await import('../agent/analyze.js');
        const analysis = await analyzeFlightPrice(parseInt(req.params.id));
        res.json(analysis);
    } catch (error) {
        console.error('[API] GET /api/flights/:id/analysis failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Send price alert email for a flight
app.post('/api/flights/:id/notify', async (req, res) => {
    try {
        const { sendPriceDropAlert } = await import('../notifications/email.js');
        const { analyzeFlightPrice } = await import('../agent/analyze.js');
        const flight = getFlightWithPrices(parseInt(req.params.id));

        if (!flight) {
            return res.status(404).json({ error: 'Flight not found' });
        }

        if (!flight.notify_email) {
            return res.status(400).json({ error: 'No email address configured for this flight' });
        }

        const prices = flight.prices || [];
        const currentPrice = prices[0]?.price || 0;
        const previousPrice = prices[1]?.price || currentPrice;
        const lowestPrice = Math.min(...prices.map(p => p.price)) || currentPrice;

        // Get price intelligence analysis
        let analysis = null;
        try {
            analysis = await analyzeFlightPrice(parseInt(req.params.id));
        } catch (e) {
            console.log('Analysis not available:', e.message);
        }

        await sendPriceDropAlert({
            to: flight.notify_email,
            flightName: flight.name,
            route: `${flight.origin} → ${flight.destination}`,
            currentPrice,
            previousPrice,
            lowestPrice,
            airline: prices[0]?.airline || 'Various',
            analysis
        });

        res.json({ success: true, message: `Email sent to ${flight.notify_email}` });
    } catch (error) {
        console.error('[API] POST /api/flights/:id/notify failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Trigger manual scrape
app.post('/api/scrape', async (req, res) => {
    try {
        const { scrapeAllFlights } = await import('../scraper/google-flights.js');
        const result = await scrapeAllFlights();
        res.json(result);
    } catch (error) {
        console.error('[API] Scrape error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Cron endpoint for Vercel - runs every 6 hours
app.get('/api/cron', async (req, res) => {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.authorization;
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        console.log('[Cron] Triggered by Vercel cron job');
        const { checkAndSendPriceUpdates } = await import('../scheduler/alerts.js');
        await checkAndSendPriceUpdates();
        res.json({ success: true, message: 'Price check and emails completed' });
    } catch (error) {
        console.error('[Cron] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`
    ✈️  Flight Tracker running at http://localhost:${PORT}

    Made with love for Mom - Christmas 2025
    `);

    // Start automatic price drop alerts (only locally, Vercel uses cron endpoint)
    if (!process.env.VERCEL) {
        startScheduler();
    }
});

// Export for Vercel serverless
export default app;
