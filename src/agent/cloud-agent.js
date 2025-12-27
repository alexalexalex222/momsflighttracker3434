#!/usr/bin/env node
/**
 * CLOUD AGENT - Lightweight agent using free OpenRouter models
 *
 * Unlike local-agent.js which spawns heavy Claude CLI processes,
 * this agent makes simple HTTP API calls to OpenRouter's free models.
 *
 * Benefits:
 * - Near-zero CPU usage (just HTTP calls)
 * - No browser automation required
 * - Uses free models like xiaomi/mimo-v2-flash:free
 *
 * Trade-offs:
 * - Cannot scrape Google Flights directly (no browser)
 * - Relies on web search APIs for current prices
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node src/agent/cloud-agent.js
 */

import 'dotenv/config';

const RAILWAY_URL = process.env.RAILWAY_URL || process.env.LOCAL_AGENT_URL;
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 15000; // 15 seconds

// No API keys needed! We use Railway's Puppeteer scraper for free Google Flights prices

// Free model on OpenRouter
const MODEL = process.env.OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free';

if (!RAILWAY_URL) {
    console.error('[CloudAgent] RAILWAY_URL environment variable required');
    process.exit(1);
}

if (!OPENROUTER_API_KEY) {
    console.error('[CloudAgent] OPENROUTER_API_KEY environment variable required');
    console.error('  Get a free key at: https://openrouter.ai/keys');
    process.exit(1);
}

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  ✈️  FLIGHT TRACKER - CLOUD AGENT (Lightweight)                ║
║                                                               ║
║  Server: ${RAILWAY_URL.substring(0, 45).padEnd(45)}║
║  Model: ${MODEL.substring(0, 46).padEnd(46)}║
║  Prices: ✓ FREE via Railway Puppeteer (no API key needed!)   ║
║  Interval: ${String(POLL_INTERVAL_MS / 1000).padEnd(4)}seconds                                      ║
║                                                               ║
║  Uses Railway's Puppeteer to scrape Google Flights for free! ║
╚═══════════════════════════════════════════════════════════════╝
`);

// ============================================================================
// Railway API helpers
// ============================================================================

async function fetchWithAuth(url, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(AGENT_TOKEN ? { 'Authorization': `Bearer ${AGENT_TOKEN}` } : {}),
        ...options.headers
    };
    return fetch(url, { ...options, headers });
}

async function pollForJob() {
    try {
        const response = await fetchWithAuth(`${RAILWAY_URL}/api/agent/jobs`);
        if (response.status === 204) return null;
        if (!response.ok) {
            console.error(`[CloudAgent] Poll failed: ${response.status}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error('[CloudAgent] Poll error:', error.message);
        return null;
    }
}

async function completeJob(jobId, result) {
    try {
        // Server expects { status: 'success'|'error', result: {...} }
        const body = {
            status: result.success ? 'success' : 'error',
            result: result,
            error_text: result.error || null
        };
        const response = await fetchWithAuth(`${RAILWAY_URL}/api/agent/jobs/${jobId}/complete`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
        return response.ok;
    } catch (error) {
        console.error('[CloudAgent] Complete error:', error.message);
        return false;
    }
}

async function getFlightFromRailway(flightId) {
    try {
        const response = await fetchWithAuth(`${RAILWAY_URL}/api/flights/${flightId}`);
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        return null;
    }
}

async function getPriceHistory(flightId) {
    try {
        const response = await fetchWithAuth(`${RAILWAY_URL}/api/flights/${flightId}/prices`);
        if (!response.ok) return [];
        const data = await response.json();
        return data.prices || [];
    } catch (error) {
        return [];
    }
}

// ============================================================================
// Railway Puppeteer Scraper - FREE Google Flights prices (no API key needed!)
// ============================================================================

async function scrapeFlightOnServer(flightId) {
    // Call Railway's /api/flights/:id/scrape endpoint which uses Puppeteer
    // This runs on Railway's servers - NOT on your Mac!
    try {
        console.log(`[CloudAgent] Asking Railway to scrape flight ${flightId}...`);

        const response = await fetchWithAuth(`${RAILWAY_URL}/api/flights/${flightId}/scrape`, {
            method: 'POST'
        });

        if (!response.ok) {
            console.error('[CloudAgent] Server scrape failed:', response.status);
            return null;
        }

        const data = await response.json();

        if (data.success && data.price) {
            console.log(`[CloudAgent] ✓ Got price: $${data.price} on ${data.airline}`);
            return {
                price: data.price,
                currency: 'USD',
                airline: data.airline || 'Unknown',
                source: 'google_flights_puppeteer'
            };
        }

        return null;
    } catch (error) {
        console.error('[CloudAgent] Server scrape error:', error.message);
        return null;
    }
}

// ============================================================================
// OpenRouter API - Call free LLM
// ============================================================================

async function callOpenRouter(prompt, systemPrompt = '') {
    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': RAILWAY_URL,
                'X-Title': 'Flight Tracker'
            },
            body: JSON.stringify({
                model: MODEL,
                messages,
                max_tokens: 2000,
                temperature: 0.3
            })
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('[CloudAgent] OpenRouter error:', response.status, error);
            return null;
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content || null;
    } catch (error) {
        console.error('[CloudAgent] OpenRouter call failed:', error.message);
        return null;
    }
}

// ============================================================================
// Web Search using DuckDuckGo (no API key needed)
// ============================================================================

async function webSearch(query) {
    try {
        // DuckDuckGo Instant Answer API (free, no key needed)
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();

        // Extract useful info
        const results = [];
        if (data.Abstract) results.push(data.Abstract);
        if (data.RelatedTopics) {
            for (const topic of data.RelatedTopics.slice(0, 3)) {
                if (topic.Text) results.push(topic.Text);
            }
        }
        return results.join('\n\n') || 'No results found';
    } catch (error) {
        console.error('[CloudAgent] Search error:', error.message);
        return null;
    }
}

// Alternative: Use a simple news API or scrape headlines
async function getFlightNews(origin, destination) {
    // For now, return basic info - can be enhanced with actual news API
    const destCity = destination.length === 3 ? destination : destination;
    const searchResults = await webSearch(`${destCity} travel news 2025`);
    return searchResults || 'No recent news found';
}

// ============================================================================
// Job handlers
// ============================================================================

async function handleCheckNow(job, flight) {
    console.log(`[CloudAgent] CHECK NOW: ${flight.name}`);
    console.log(`[CloudAgent] Route: ${flight.origin} → ${flight.destination}`);

    // Get REAL price from Railway's Puppeteer scraper (FREE!)
    const realPrice = await scrapeFlightOnServer(flight.id);

    if (realPrice) {
        // Got a real price from Google Flights via Puppeteer!
        return {
            success: true,
            price: realPrice.price,
            currency: realPrice.currency,
            airline: realPrice.airline,
            source: 'google_flights_puppeteer',
            note: 'Real Google Flights price via Railway Puppeteer'
        };
    }

    // Fallback: Use LLM estimation if scrape failed
    console.log('[CloudAgent] Server scrape failed, using LLM estimation...');
    const prices = await getPriceHistory(flight.id);
    const latestPrice = prices[0]?.price || null;

    const prompt = `
You are a flight price analyst. Estimate the current price for this flight.

FLIGHT:
- Route: ${flight.origin} to ${flight.destination}
- Date: ${flight.departure_date}
- Cabin: ${flight.cabin_class || 'economy'}

TRACKED PRICE HISTORY:
${prices.length > 0
    ? prices.slice(0, 5).map(p => `- ${p.checked_at}: $${p.price}`).join('\n')
    : '- No historical data yet'}

Based on typical flight pricing, estimate current price.

Respond with ONLY this JSON:
{
    "success": true,
    "price": <estimated price number>,
    "currency": "USD",
    "airline": "Various",
    "source": "llm_estimate",
    "note": "<one sentence about your estimate>"
}`;

    const response = await callOpenRouter(prompt, 'You are a flight pricing expert. Respond with valid JSON only.');

    if (!response) {
        return {
            success: false,
            error: 'Cloud model did not respond'
        };
    }

    try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            return result;
        }
        return { success: false, error: 'Invalid response format' };
    } catch (e) {
        console.error('[CloudAgent] Parse error:', e.message);
        return { success: false, error: 'Failed to parse response' };
    }
}

async function handleFullAnalysis(job, flight) {
    console.log(`[CloudAgent] FULL ANALYSIS: ${flight.name}`);
    console.log(`[CloudAgent] Route: ${flight.origin} → ${flight.destination}`);

    // Get price history
    const prices = await getPriceHistory(flight.id);
    const latestPrice = prices[0]?.price || null;
    const avgPrice = prices.length > 0
        ? Math.round(prices.reduce((sum, p) => sum + p.price, 0) / prices.length)
        : null;

    // Get destination info
    const destCity = flight.destination_city || flight.destination;
    const travelMonth = new Date(flight.departure_date).toLocaleString('en-US', { month: 'long', year: 'numeric' });

    // Do web searches for context (lightweight)
    console.log('[CloudAgent] Searching for travel context...');
    const newsSearch = await webSearch(`${destCity} travel ${travelMonth}`);
    const eventsSearch = await webSearch(`${destCity} events holidays ${travelMonth}`);

    // Build comprehensive analysis prompt
    const prompt = `
You are a travel intelligence analyst helping someone decide whether to BOOK NOW or WAIT.

FLIGHT DETAILS:
- Trip: "${flight.name}"
- Route: ${flight.origin} → ${flight.destination} (${destCity})
- Departure: ${flight.departure_date}
${flight.return_date ? `- Return: ${flight.return_date}` : '- One way'}
- Cabin: ${flight.cabin_class || 'economy'}

PRICE HISTORY FROM OUR DATABASE:
${prices.length > 0
    ? `- Latest: $${latestPrice}
- Average: $${avgPrice}
- Prices: ${prices.slice(0, 5).map(p => `$${p.price}`).join(', ')}`
    : '- No price data yet'}

WEB RESEARCH RESULTS:
Travel News: ${newsSearch || 'No results'}
Events: ${eventsSearch || 'No results'}

ANALYZE AND RESPOND:
Based on all this data, analyze whether prices are likely to go UP, DOWN, or stay STABLE.
Consider: season, events, holidays, typical booking patterns.

Respond with ONLY this JSON (no markdown):
{
    "success": true,
    "price": {
        "latest_tracked": ${latestPrice || 'null'},
        "average": ${avgPrice || 'null'},
        "currency": "USD",
        "assessment": "good|fair|high"
    },
    "prediction": {
        "direction": "up|down|stable",
        "confidence": "high|medium|low",
        "recommendation": "book_now|wait|monitor",
        "reasoning": "<2-3 sentences explaining your analysis>"
    },
    "context": {
        "summary": "<1-2 sentences about destination during travel dates>",
        "events": "<any relevant events or holidays>",
        "tips": "<one helpful travel tip>"
    }
}`;

    const response = await callOpenRouter(prompt, 'You are an expert travel analyst. Always respond with valid JSON only, no markdown formatting.');

    if (!response) {
        return {
            success: false,
            error: 'Cloud model did not respond'
        };
    }

    try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            console.log(`[CloudAgent] ✓ Analysis complete!`);
            console.log(`[CloudAgent] Recommendation: ${result.prediction?.recommendation || 'unknown'}`);
            return result;
        }
        return { success: false, error: 'Invalid response format' };
    } catch (e) {
        console.error('[CloudAgent] Parse error:', e.message);
        console.error('[CloudAgent] Raw response:', response.substring(0, 200));
        return { success: false, error: 'Failed to parse response' };
    }
}

async function handleCheckAll(job) {
    console.log(`[CloudAgent] CHECK ALL: Processing batch check`);

    // For check_all, we just analyze all flights quickly
    const results = [];
    const flightIds = job.payload?.flightIds || [];

    for (const flightId of flightIds.slice(0, 5)) { // Limit to 5 at a time
        const flight = await getFlightFromRailway(flightId);
        if (flight) {
            const result = await handleCheckNow(job, flight);
            results.push({ flightId, ...result });
        }
    }

    return {
        success: true,
        checked: results.length,
        results
    };
}

// ============================================================================
// Main job processor
// ============================================================================

async function processJob(job) {
    console.log(`\n[CloudAgent] ═══════════════════════════════════════════════`);
    console.log(`[CloudAgent] Processing job #${job.id}: ${job.type}`);

    // flight_id is at job level, not in payload
    const flightId = job.flight_id || job.payload?.flightId;
    const flight = flightId
        ? await getFlightFromRailway(flightId)
        : null;

    if (job.type !== 'check_all' && !flight) {
        console.error(`[CloudAgent] Flight not found for job ${job.id}`);
        await completeJob(job.id, { success: false, error: 'Flight not found' });
        return;
    }

    let result;

    switch (job.type) {
        case 'check_now':
            result = await handleCheckNow(job, flight);
            break;
        case 'full_analysis':
            result = await handleFullAnalysis(job, flight);
            break;
        case 'check_all':
            result = await handleCheckAll(job);
            break;
        default:
            console.log(`[CloudAgent] Unknown job type: ${job.type}, skipping`);
            result = { success: false, error: `Unknown job type: ${job.type}` };
    }

    const completed = await completeJob(job.id, result);
    if (completed) {
        console.log(`[CloudAgent] ✓ Job #${job.id} completed`);
    } else {
        console.error(`[CloudAgent] ✗ Failed to complete job #${job.id}`);
    }
}

// ============================================================================
// Poll loop
// ============================================================================

async function runPollLoop() {
    console.log('[CloudAgent] Starting poll loop...\n');

    while (true) {
        const job = await pollForJob();

        if (job) {
            await processJob(job);
        } else {
            process.stdout.write('.');
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n[CloudAgent] Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n\n[CloudAgent] Terminated.');
    process.exit(0);
});

// Start
runPollLoop().catch(error => {
    console.error('[CloudAgent] Fatal error:', error);
    process.exit(1);
});
