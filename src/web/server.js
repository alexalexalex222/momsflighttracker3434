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
import { startScheduler } from '../scheduler/alerts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));

// API Routes
app.get('/api/flights', (req, res) => {
    try {
        const flights = getAllFlightsWithLatestPrice();
        res.json(flights);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/flights', (req, res) => {
    try {
        const id = addFlight(req.body);
        res.json({ id, success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/flights/:id', (req, res) => {
    try {
        const flight = getFlightWithPrices(parseInt(req.params.id));
        res.json(flight);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/flights/:id/prices', (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const prices = getPriceHistory(parseInt(req.params.id), days);
        res.json(prices);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/flights/:id', (req, res) => {
    try {
        deactivateFlight(parseInt(req.params.id));
        res.json({ success: true });
    } catch (error) {
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

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`
    ✈️  Flight Tracker running at http://localhost:${PORT}

    Made with love for Mom - Christmas 2025
    `);

    // Start automatic price drop alerts
    startScheduler();
});
