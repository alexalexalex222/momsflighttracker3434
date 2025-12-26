#!/usr/bin/env node
import 'dotenv/config';
import { getPriceQuote } from '../src/pricing/engine.js';
import { fetchTravelContext } from '../src/context/context.js';
import { sendPriceDropAlert } from '../src/notifications/email.js';

const BASE_URL = process.env.AGENT_BASE_URL;
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const POLL_INTERVAL = Number(process.env.AGENT_POLL_INTERVAL_MS || 3000);
const EMAIL_PROVIDER = process.env.AGENT_EMAIL_PROVIDER || 'mcp';

if (!BASE_URL) {
    console.error('Missing AGENT_BASE_URL (e.g. https://your-app.up.railway.app)');
    process.exit(1);
}

if (EMAIL_PROVIDER) {
    process.env.EMAIL_PROVIDER = EMAIL_PROVIDER;
}

function authHeaders() {
    if (!AGENT_TOKEN) return {};
    return { Authorization: `Bearer ${AGENT_TOKEN}` };
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiFetch(path, options = {}) {
    const url = `${BASE_URL}${path}`;
    const headers = { ...(options.headers || {}), ...authHeaders() };
    const res = await fetch(url, { ...options, headers });
    return res;
}

async function readJsonSafe(res) {
    try { return await res.json(); } catch { return null; }
}

async function claimJob() {
    const res = await apiFetch('/api/agent/jobs');
    if (res.status === 204) return null;
    if (!res.ok) {
        const data = await readJsonSafe(res);
        throw new Error(data?.error || `Agent job fetch failed (${res.status})`);
    }
    return readJsonSafe(res);
}

async function completeJob(jobId, payload) {
    const res = await apiFetch(`/api/agent/jobs/${jobId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const data = await readJsonSafe(res);
        throw new Error(data?.error || `Complete failed (${res.status})`);
    }
}

async function fetchFlight(id) {
    const res = await apiFetch(`/api/flights/${id}`);
    const data = await readJsonSafe(res);
    if (!res.ok) throw new Error(data?.error || `Flight fetch failed (${res.status})`);
    return data;
}

async function fetchFlights() {
    const res = await apiFetch('/api/flights');
    const data = await readJsonSafe(res);
    if (!res.ok) throw new Error(data?.error || `Flights fetch failed (${res.status})`);
    return Array.isArray(data) ? data : [];
}

async function handleCheckNow(job) {
    const flight = job.payload?.flight || await fetchFlight(job.flight_id);
    const quote = await getPriceQuote(flight);
    await completeJob(job.id, {
        status: 'success',
        result: {
            flight_id: flight.id,
            price: quote.price,
            currency: quote.currency || 'USD',
            airline: quote.airline || null,
            source: quote.source || 'unknown',
            raw_data: quote.raw_data || null
        }
    });
}

async function handleCheckAll(job) {
    const flights = await fetchFlights();
    const results = [];

    for (const flight of flights) {
        try {
            const quote = await getPriceQuote(flight);
            results.push({
                flight_id: flight.id,
                price: quote.price,
                currency: quote.currency || 'USD',
                airline: quote.airline || null,
                source: quote.source || 'unknown',
                raw_data: quote.raw_data || null
            });
        } catch (err) {
            results.push({
                flight_id: flight.id,
                error: err?.message || String(err)
            });
        }
    }

    await completeJob(job.id, { status: 'success', result: { results } });
}

function addDays(dateStr, delta) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + delta);
    return d.toISOString().slice(0, 10);
}

async function handleFlexScan(job) {
    const flight = job.payload?.flight || await fetchFlight(job.flight_id);
    const window = job.payload?.window || 5;
    const depart = flight.departure_date;
    const tripLength = flight.return_date
        ? Math.round((new Date(flight.return_date) - new Date(flight.departure_date)) / (1000 * 60 * 60 * 24))
        : null;

    const results = [];
    for (let delta = -window; delta <= window; delta += 1) {
        const depart2 = addDays(depart, delta);
        const return2 = tripLength !== null ? addDays(depart2, tripLength) : '';
        const shifted = { ...flight, departure_date: depart2, return_date: return2 || null };

        try {
            const quote = await getPriceQuote(shifted);
            results.push({
                departure_date: depart2,
                return_date: return2 || '',
                cabin_class: flight.cabin_class || 'economy',
                passengers: flight.passengers || 1,
                price: quote.price,
                currency: quote.currency || 'USD',
                airline: quote.airline || null,
                source: quote.source || 'unknown'
            });
        } catch (err) {
            results.push({
                departure_date: depart2,
                return_date: return2 || '',
                cabin_class: flight.cabin_class || 'economy',
                passengers: flight.passengers || 1,
                price: null,
                currency: 'USD',
                airline: null,
                source: 'error',
                error: err?.message || String(err)
            });
        }
    }

    await completeJob(job.id, { status: 'success', result: { results } });
}

async function handleContextRefresh(job) {
    const flight = job.payload?.flight || await fetchFlight(job.flight_id);
    const context = await fetchTravelContext(flight);
    await completeJob(job.id, { status: 'success', result: { context } });
}

async function handleSendEmail(job) {
    const flight = await fetchFlight(job.flight_id);
    const prices = flight.prices || [];
    const currentPrice = prices[0]?.price || 0;
    const previousPrice = prices[1]?.price || currentPrice;
    const lowestPrice = Math.min(...prices.map(p => p.price)) || currentPrice;

    let flexSuggestion = null;
    try {
        const flexRes = await apiFetch(`/api/flights/${flight.id}/flex?window=5&maxAgeHours=12`);
        const flexData = await readJsonSafe(flexRes);
        if (flexRes.ok && flexData?.rows?.length) {
            const best = flexData.rows.reduce((min, row) => row.price !== null && row.price < min.price ? row : min, flexData.rows[0]);
            if (best?.price) {
                flexSuggestion = {
                    price: best.price,
                    departure_date: best.departure_date,
                    return_date: best.return_date,
                    savings: Math.max(0, Math.round(currentPrice - best.price))
                };
            }
        }
    } catch {
        // ignore flex
    }

    let context = null;
    try {
        const ctxRes = await apiFetch(`/api/flights/${flight.id}/context?maxAgeHours=6`);
        const ctxData = await readJsonSafe(ctxRes);
        if (ctxRes.ok && ctxData?.context) context = ctxData.context;
    } catch {
        // ignore context
    }

    let nextRunAt = null;
    try {
        const schedRes = await apiFetch('/api/schedule');
        const schedData = await readJsonSafe(schedRes);
        if (schedRes.ok) nextRunAt = schedData?.nextRunAt || null;
    } catch {
        // ignore schedule
    }

    await sendPriceDropAlert({
        to: flight.notify_email,
        flightName: flight.name,
        route: `${flight.origin} → ${flight.destination}`,
        currentPrice,
        previousPrice,
        lowestPrice,
        airline: prices[0]?.airline || 'Various',
        analysis: null,
        flexSuggestion,
        context,
        nextRunAt
    });

    await completeJob(job.id, { status: 'success', result: { sent: true } });
}

async function processJob(job) {
    try {
        switch (job.type) {
            case 'check_now':
                await handleCheckNow(job);
                break;
            case 'check_all':
                await handleCheckAll(job);
                break;
            case 'flex_scan':
                await handleFlexScan(job);
                break;
            case 'context_refresh':
                await handleContextRefresh(job);
                break;
            case 'send_email':
                await handleSendEmail(job);
                break;
            default:
                await completeJob(job.id, { status: 'error', error_text: `Unknown job type: ${job.type}` });
        }
    } catch (err) {
        await completeJob(job.id, { status: 'error', error_text: err?.message || String(err) });
    }
}

async function run() {
    console.log(`[Agent] polling ${BASE_URL} every ${POLL_INTERVAL}ms`);
    while (true) {
        try {
            const job = await claimJob();
            if (job) {
                console.log(`[Agent] claimed job ${job.id} (${job.type})`);
                await processJob(job);
            } else {
                await sleep(POLL_INTERVAL);
            }
        } catch (err) {
            console.error('[Agent] error:', err?.message || err);
            await sleep(POLL_INTERVAL);
        }
    }
}

run();
