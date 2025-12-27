import 'dotenv/config';
import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    initializeDatabase,
    addFlight,
    getFlight,
    getFlightWithPrices,
    getAllFlightsWithLatestPrice,
    deactivateFlight,
    getPriceHistory,
    updateFlight,
    savePrice,
    updateFlightCheckStatus,
    getJob,
    claimNextJob,
    updateJob,
    createJob,
    getFlexPrices,
    getBestFlexPrice,
    upsertFlexPrice,
    getContext,
    upsertContext
} from '../db/postgres.js';
import { startScheduler } from '../scheduler/alerts.js';
import { createAndRunJob } from '../jobs/runner.js';
import { getScheduleInfo } from '../scheduler/schedule.js';
import { fetchTravelContext } from '../context/context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const AGENT_TOKEN = process.env.AGENT_TOKEN || null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));

function requireAgentAuth(req, res, next) {
    if (!AGENT_TOKEN) return next();
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '').trim();
    if (token && token === AGENT_TOKEN) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

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

function isValidCabinClass(value) {
    const allowed = ['economy', 'premium_economy', 'business', 'first'];
    return allowed.includes((value || '').toLowerCase());
}

function parsePassengers(value) {
    if (value === undefined || value === null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

// Initialize PostgreSQL database on startup
(async () => {
    try {
        await initializeDatabase();
        console.log('[DB] PostgreSQL ready');
    } catch (error) {
        console.error('[DB] PostgreSQL initialization failed:', error);
        process.exit(1);
    }
})();

// API Routes
app.get('/api/health', async (req, res) => {
    let dbOk = true;
    let dbError = null;

    try {
        const { query } = await import('../db/postgres.js');
        await query('SELECT 1');
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
            type: 'postgresql',
            error: dbError
        },
        email: {
            resendConfigured: Boolean(process.env.RESEND_API_KEY || process.env.RESEND_KEY),
            resendKeyPresent: Object.prototype.hasOwnProperty.call(process.env, 'RESEND_API_KEY') ||
                Object.prototype.hasOwnProperty.call(process.env, 'RESEND_KEY'),
            resendKeyLength: (process.env.RESEND_API_KEY || process.env.RESEND_KEY || '').length || 0,
            resendKeyLooksValid: /^(re|rs)_[A-Za-z0-9_]+$/.test((process.env.RESEND_API_KEY || process.env.RESEND_KEY || '').trim()),
            resendKeySource: process.env.RESEND_API_KEY
                ? 'RESEND_API_KEY'
                : (process.env.RESEND_KEY ? 'RESEND_KEY' : null),
            zapierConfigured: Boolean(process.env.ZAPIER_WEBHOOK_URL)
        },
        build: {
            railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
            vercelCommit: process.env.VERCEL_GIT_COMMIT_SHA || null,
            githubSha: process.env.GITHUB_SHA || null
        }
    });
});

app.get('/api/flights', async (req, res) => {
    try {
        const flights = await getAllFlightsWithLatestPrice();
        res.json(flights);
    } catch (error) {
        console.error('[API] GET /api/flights failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/flights', async (req, res) => {
    try {
        const body = req.body || {};
        const errors = [];

        if (!isNonEmptyString(body.name)) errors.push('Trip Name is required');
        if (!isValidAirportCode(body.origin)) errors.push('From must be a 3-letter airport code (ex: ATL)');
        if (!isValidAirportCode(body.destination)) errors.push('To must be a 3-letter airport code (ex: SFO)');
        if (!isValidIsoDate(body.departure_date)) errors.push('Departure date is required');
        if (body.return_date && !isValidIsoDate(body.return_date)) errors.push('Return date must be a valid date');
        const passengers = parsePassengers(body.passengers);
        if (body.passengers !== undefined && (passengers === null || passengers < 1 || passengers > 9)) {
            errors.push('Travelers must be between 1 and 9');
        }
        if (body.cabin_class && !isValidCabinClass(body.cabin_class)) {
            errors.push('Cabin class must be economy, premium_economy, business, or first');
        }
        if (body.notify_email && !isValidEmail(body.notify_email)) errors.push('Email must be valid');

        if (errors.length) {
            return res.status(400).json({ error: errors.join('. ') });
        }

        const id = await addFlight({ ...body, passengers: passengers ?? body.passengers });
        res.json({ id, success: true });
    } catch (error) {
        console.error('[API] POST /api/flights failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/flights/:id', async (req, res) => {
    try {
        const body = req.body || {};
        const errors = [];

        if (body.name !== undefined && !isNonEmptyString(body.name)) errors.push('Trip Name is required');
        if (body.origin !== undefined && !isValidAirportCode(body.origin)) errors.push('From must be a 3-letter airport code (ex: ATL)');
        if (body.destination !== undefined && !isValidAirportCode(body.destination)) errors.push('To must be a 3-letter airport code (ex: SFO)');
        if (body.departure_date !== undefined && !isValidIsoDate(body.departure_date)) errors.push('Departure date must be valid');
        if (body.return_date && !isValidIsoDate(body.return_date)) errors.push('Return date must be valid');
        const passengers = parsePassengers(body.passengers);
        if (body.passengers !== undefined && (passengers === null || passengers < 1 || passengers > 9)) {
            errors.push('Travelers must be between 1 and 9');
        }
        if (body.cabin_class !== undefined && !isValidCabinClass(body.cabin_class)) {
            errors.push('Cabin class must be economy, premium_economy, business, or first');
        }
        if (body.notify_email !== undefined && body.notify_email && !isValidEmail(body.notify_email)) {
            errors.push('Email must be valid');
        }

        if (errors.length) {
            return res.status(400).json({ error: errors.join('. ') });
        }

        const updated = await updateFlight(parseInt(req.params.id), { ...body, passengers: passengers ?? body.passengers });
        if (!updated) {
            return res.status(404).json({ error: 'Flight not found' });
        }
        res.json(updated);
    } catch (error) {
        console.error('[API] PUT /api/flights/:id failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/flights/:id', async (req, res) => {
    try {
        const flight = await getFlightWithPrices(parseInt(req.params.id));
        if (!flight) return res.status(404).json({ error: 'Flight not found' });
        res.json(flight);
    } catch (error) {
        console.error('[API] GET /api/flights/:id failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/flights/:id/prices', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const prices = await getPriceHistory(parseInt(req.params.id), days);
        res.json(prices);
    } catch (error) {
        console.error('[API] GET /api/flights/:id/prices failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/flights/:id/check', async (req, res) => {
    try {
        const flightId = parseInt(req.params.id);
        const jobId = await createAndRunJob({
            type: 'check_now',
            flightId,
            progressTotal: 1,
            payload: { origin: 'railway', requested_at: new Date().toISOString() }
        });
        res.json({ jobId });
    } catch (error) {
        console.error('[API] POST /api/flights/:id/check failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/flights/check', async (req, res) => {
    try {
        const jobId = await createAndRunJob({
            type: 'check_all',
            payload: { origin: 'railway', requested_at: new Date().toISOString() }
        });
        res.json({ jobId });
    } catch (error) {
        console.error('[API] POST /api/flights/check failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Full travel intelligence analysis (price + 5 web searches + prediction)
app.post('/api/flights/:id/analyze', async (req, res) => {
    try {
        const flightId = parseInt(req.params.id);
        const jobId = await createAndRunJob({
            type: 'full_analysis',
            flightId,
            progressTotal: 1,
            payload: { origin: 'railway', requested_at: new Date().toISOString() }
        });
        res.json({ jobId });
    } catch (error) {
        console.error('[API] POST /api/flights/:id/analyze failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/jobs/:id', async (req, res) => {
    try {
        const job = await getJob(parseInt(req.params.id));
        if (!job) return res.status(404).json({ error: 'Job not found' });
        res.json(job);
    } catch (error) {
        console.error('[API] GET /api/jobs/:id failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Local agent polling (Mac Claude/MCP runner)
app.get('/api/agent/jobs', requireAgentAuth, async (req, res) => {
    try {
        const job = await claimNextJob();
        if (!job) return res.status(204).end();
        let payload = null;
        try {
            payload = job.payload_json ? JSON.parse(job.payload_json) : null;
        } catch {
            payload = null;
        }
        res.json({ ...job, payload });
    } catch (error) {
        console.error('[API] GET /api/agent/jobs failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/agent/jobs/:id/complete', requireAgentAuth, async (req, res) => {
    try {
        const jobId = parseInt(req.params.id);
        const job = await getJob(jobId);
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const { status, result, error_text, progress_current } = req.body || {};
        const finalStatus = status === 'success' ? 'success' : 'error';

        if (typeof progress_current === 'number') {
            await updateJob(jobId, { progress_current });
        }

        if (finalStatus === 'error') {
            await updateJob(jobId, {
                status: 'error',
                error_text: error_text || 'Agent reported error',
                finished_at: new Date().toISOString()
            });
            return res.json({ ok: true });
        }

        // Apply side effects based on job type
        if (job.type === 'check_now' && result) {
            await savePrice({
                flight_id: job.flight_id,
                price: result.price,
                currency: result.currency || 'USD',
                airline: result.airline || null,
                raw_data: result.raw_data || null,
                source: result.source || null
            });
            await updateFlightCheckStatus(job.flight_id, 'ok', null);
        }

        if (job.type === 'check_all' && result?.results) {
            for (const row of result.results) {
                if (!row?.flight_id || !row.price) continue;
                await savePrice({
                    flight_id: row.flight_id,
                    price: row.price,
                    currency: row.currency || 'USD',
                    airline: row.airline || null,
                    raw_data: row.raw_data || null,
                    source: row.source || null
                });
                await updateFlightCheckStatus(row.flight_id, 'ok', null);
            }
        }

        if (job.type === 'flex_scan' && result?.results) {
            for (const row of result.results) {
                await upsertFlexPrice({
                    flight_id: job.flight_id,
                    departure_date: row.departure_date,
                    return_date: row.return_date || '',
                    cabin_class: row.cabin_class || 'economy',
                    passengers: row.passengers || 1,
                    price: row.price ?? null,
                    currency: row.currency || 'USD',
                    airline: row.airline || null,
                    source: row.source || 'unknown'
                });
            }
        }

        if (job.type === 'context_refresh' && result?.context) {
            await upsertContext({
                flight_id: job.flight_id,
                context_json: JSON.stringify(result.context),
                expires_at: result.context.expires_at || null
            });
        }

        await updateJob(jobId, {
            status: 'success',
            result_json: JSON.stringify(result || {}),
            finished_at: new Date().toISOString()
        });

        res.json({ ok: true });
    } catch (error) {
        console.error('[API] POST /api/agent/jobs/:id/complete failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Reset stuck jobs (running > 5 minutes)
app.post('/api/agent/reset-stuck', requireAgentAuth, async (req, res) => {
    try {
        const result = await query(`
            UPDATE jobs
            SET status = 'queued', started_at = NULL
            WHERE status = 'running'
            AND started_at < NOW() - INTERVAL '5 minutes'
            RETURNING id
        `);
        const resetIds = result.rows.map(r => r.id);
        console.log(`[API] Reset ${resetIds.length} stuck jobs:`, resetIds);
        res.json({ reset: resetIds.length, jobIds: resetIds });
    } catch (error) {
        console.error('[API] POST /api/agent/reset-stuck failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/flights/:id/flex-scan', async (req, res) => {
    try {
        const flightId = parseInt(req.params.id);
        const window = parseInt(req.query.window) || 5;
        const progressTotal = window * 2 + 1;
        const jobId = await createAndRunJob({
            type: 'flex_scan',
            flightId,
            progressTotal,
            window,
            payload: { origin: 'railway', window, requested_at: new Date().toISOString() }
        });
        res.json({ jobId });
    } catch (error) {
        console.error('[API] POST /api/flights/:id/flex-scan failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/flights/:id/flex', async (req, res) => {
    try {
        const flightId = parseInt(req.params.id);
        const window = parseInt(req.query.window) || 5;
        const maxAgeHours = parseInt(req.query.maxAgeHours) || 6;
        const flight = await getFlight(flightId);
        if (!flight) return res.status(404).json({ error: 'Flight not found' });

        const { rows, isComplete } = await getFlexPrices({
            flight_id: flightId,
            window,
            maxAgeHours,
            cabin_class: flight.cabin_class,
            passengers: flight.passengers || 1
        });
        if (!rows.length || !isComplete) {
            return res.json({ needsScan: true, rows });
        }
        res.json({ rows });
    } catch (error) {
        console.error('[API] GET /api/flights/:id/flex failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/flights/:id/context-refresh', async (req, res) => {
    try {
        const flightId = parseInt(req.params.id);
        const jobId = await createAndRunJob({
            type: 'context_refresh',
            flightId,
            progressTotal: 1,
            payload: { origin: 'railway', requested_at: new Date().toISOString() }
        });
        res.json({ jobId });
    } catch (error) {
        console.error('[API] POST /api/flights/:id/context-refresh failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/flights/:id/context', async (req, res) => {
    try {
        const flightId = parseInt(req.params.id);
        const maxAgeHours = parseInt(req.query.maxAgeHours) || 6;
        const cached = await getContext({ flight_id: flightId, maxAgeHours });
        if (!cached) {
            return res.json({ needsRefresh: true });
        }

        let context = null;
        try {
            context = JSON.parse(cached.context_json);
        } catch (e) {
            context = null;
        }

        if (!context) {
            return res.json({ needsRefresh: true });
        }

        res.json({ context });
    } catch (error) {
        console.error('[API] GET /api/flights/:id/context failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/schedule', (req, res) => {
    try {
        res.json(getScheduleInfo());
    } catch (error) {
        console.error('[API] GET /api/schedule failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/flights/:id', async (req, res) => {
    try {
        await deactivateFlight(parseInt(req.params.id));
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
        const flight = await getFlightWithPrices(parseInt(req.params.id));

        if (!flight) {
            return res.status(404).json({ error: 'Flight not found' });
        }

        if (!flight.notify_email) {
            return res.status(400).json({ error: 'No email address configured for this flight' });
        }

        const localAgentEnabled = ['1', 'true', 'yes'].includes(String(process.env.LOCAL_AGENT_ENABLED || '').toLowerCase());
        if (localAgentEnabled) {
            const jobId = await createJob({
                type: 'send_email',
                flight_id: flight.id,
                progress_total: 1,
                payload_json: JSON.stringify({ origin: 'manual_notify', flight_id: flight.id })
            });
            return res.json({ queued: true, jobId });
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

        // Flex suggestion (cached)
        const bestFlex = await getBestFlexPrice({
            flight_id: flight.id,
            maxAgeHours: 12,
            cabin_class: flight.cabin_class,
            passengers: flight.passengers || 1
        });
        const flexSuggestion = bestFlex?.price ? {
            price: bestFlex.price,
            departure_date: bestFlex.departure_date,
            return_date: bestFlex.return_date,
            savings: Math.max(0, Math.round(currentPrice - bestFlex.price))
        } : null;

        // Context (cached or refresh)
        let context = null;
        const cachedContext = await getContext({ flight_id: flight.id, maxAgeHours: 6 });
        if (cachedContext?.context_json) {
            try {
                context = JSON.parse(cachedContext.context_json);
            } catch (e) {
                context = null;
            }
        }

        if (!context) {
            try {
                context = await fetchTravelContext(flight);
                await upsertContext({
                    flight_id: flight.id,
                    context_json: JSON.stringify(context),
                    expires_at: context.expires_at || null
                });
            } catch (e) {
                console.log('Context not available:', e.message);
            }
        }

        const scheduleInfo = getScheduleInfo();

        await sendPriceDropAlert({
            to: flight.notify_email,
            flightName: flight.name,
            route: `${flight.origin} → ${flight.destination}`,
            currentPrice,
            previousPrice,
            lowestPrice,
            airline: prices[0]?.airline || 'Various',
            analysis,
            flexSuggestion,
            context,
            nextRunAt: scheduleInfo.nextRunAt
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
