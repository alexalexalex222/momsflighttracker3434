#!/usr/bin/env node
/**
 * LOCAL AGENT - Runs on your Mac, polls Railway for jobs, executes with Claude CLI
 *
 * This bridges Railway (web UI) with Claude CLI (browser automation).
 * Mom clicks a button on the web → Railway creates a job → this script picks it up →
 * runs Claude with Chrome → posts results back to Railway.
 *
 * Usage:
 *   RAILWAY_URL=https://your-app.up.railway.app AGENT_TOKEN=secret node src/agent/local-agent.js
 *
 * Or create a .env.local file with those values.
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import { getFlight } from '../db/flights.js';

const RAILWAY_URL = process.env.RAILWAY_URL || process.env.LOCAL_AGENT_URL;
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 10000; // 10 seconds

if (!RAILWAY_URL) {
    console.error('[LocalAgent] RAILWAY_URL environment variable required');
    console.error('  Example: RAILWAY_URL=https://web-production-f3df9.up.railway.app');
    process.exit(1);
}

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  ✈️  FLIGHT TRACKER - LOCAL AGENT                              ║
║                                                               ║
║  Polling: ${RAILWAY_URL.padEnd(44)}║
║  Interval: ${String(POLL_INTERVAL_MS / 1000).padEnd(4)}seconds                                      ║
║                                                               ║
║  This agent runs Claude CLI with Chrome to scrape flights.    ║
║  Keep this running while you want automatic price checks.     ║
╚═══════════════════════════════════════════════════════════════╝
`);

async function fetchWithAuth(url, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(AGENT_TOKEN ? { 'Authorization': `Bearer ${AGENT_TOKEN}` } : {}),
        ...options.headers
    };

    const response = await fetch(url, { ...options, headers });
    return response;
}

async function pollForJob() {
    try {
        const response = await fetchWithAuth(`${RAILWAY_URL}/api/agent/jobs`);

        if (response.status === 204) {
            // No pending jobs
            return null;
        }

        if (!response.ok) {
            console.error(`[LocalAgent] Poll failed: ${response.status} ${response.statusText}`);
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error('[LocalAgent] Poll error:', error.message);
        return null;
    }
}

async function completeJob(jobId, result) {
    try {
        const response = await fetchWithAuth(`${RAILWAY_URL}/api/agent/jobs/${jobId}/complete`, {
            method: 'POST',
            body: JSON.stringify(result)
        });

        if (!response.ok) {
            console.error(`[LocalAgent] Complete failed: ${response.status}`);
            return false;
        }

        return true;
    } catch (error) {
        console.error('[LocalAgent] Complete error:', error.message);
        return false;
    }
}

async function getFlightFromRailway(flightId) {
    try {
        const response = await fetchWithAuth(`${RAILWAY_URL}/api/flights/${flightId}`);
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.error('[LocalAgent] Get flight error:', error.message);
        return null;
    }
}

function buildScrapePrompt(flight, jobType, historicalPrices = []) {
    const cabinMap = {
        'economy': 'Economy',
        'premium_economy': 'Premium Economy',
        'business': 'Business',
        'first': 'First Class'
    };
    const cabinName = cabinMap[flight.cabin_class] || 'Economy';
    const passengers = flight.passengers || 1;

    // Get destination city name for searches
    const destCity = flight.destination_city || flight.destination;
    const originCity = flight.origin_city || flight.origin;
    const travelMonth = new Date(flight.departure_date).toLocaleString('en-US', { month: 'long', year: 'numeric' });

    if (jobType === 'check_now') {
        return `
You are a flight price checker. Search Google Flights for this route and extract the price.

FLIGHT DETAILS:
- Route: ${flight.origin} to ${flight.destination}
- Departure: ${flight.departure_date}
${flight.return_date ? `- Return: ${flight.return_date}` : '- One way'}
- Passengers: ${passengers}
- Cabin Class: ${cabinName}
${flight.preferred_airline ? `- Preferred Airline: ${flight.preferred_airline}` : ''}

INSTRUCTIONS:
1. Go to Google Flights (google.com/travel/flights)
2. Enter the origin and destination airports
3. Set the departure date${flight.return_date ? ' and return date' : ''}
4. Click the cabin class dropdown and select "${cabinName}"
5. Set passenger count to ${passengers}
${flight.preferred_airline ? `6. Filter by ${flight.preferred_airline} if possible` : ''}
7. Find the cheapest available flight matching these criteria
8. Return the result as JSON

OUTPUT FORMAT (respond with ONLY this JSON, no other text):
{
    "success": true,
    "price": <number>,
    "currency": "USD",
    "airline": "<airline name>",
    "source": "google_flights_claude"
}

If you cannot find a price, return:
{
    "success": false,
    "error": "<reason>"
}
`;
    }

    if (jobType === 'full_analysis') {
        const historyStr = historicalPrices.length > 0
            ? historicalPrices.map(p => `  - ${p.checked_at}: $${p.price} (${p.airline || 'Unknown'})`).join('\n')
            : '  No historical data yet';

        return `
You are a travel intelligence analyst helping someone decide whether to book a flight NOW or WAIT.

═══════════════════════════════════════════════════════════════════════════════
FLIGHT DETAILS
═══════════════════════════════════════════════════════════════════════════════
- Trip: "${flight.name}"
- Route: ${originCity} (${flight.origin}) → ${destCity} (${flight.destination})
- Departure: ${flight.departure_date}
${flight.return_date ? `- Return: ${flight.return_date}` : '- One way'}
- Travelers: ${passengers}
- Cabin: ${cabinName}
${flight.preferred_airline ? `- Preferred Airline: ${flight.preferred_airline}` : ''}

═══════════════════════════════════════════════════════════════════════════════
HISTORICAL PRICES (from our database)
═══════════════════════════════════════════════════════════════════════════════
${historyStr}

═══════════════════════════════════════════════════════════════════════════════
YOUR TASKS (do ALL of these)
═══════════════════════════════════════════════════════════════════════════════

TASK 1: GET CURRENT PRICE (Browser Automation)
- Go to Google Flights (google.com/travel/flights)
- Enter: ${flight.origin} to ${flight.destination}
- Set dates: ${flight.departure_date}${flight.return_date ? ` to ${flight.return_date}` : ''}
- IMPORTANT: Click the cabin class dropdown and SELECT "${cabinName}"
- Get the cheapest price for this cabin class
- Note the airline

TASK 2: WEB RESEARCH (Use WebSearch tool - do all 5 searches)
Search for context that affects flight prices and travel:

1. NEWS & SAFETY: "${destCity} travel news ${travelMonth}" OR "${destCity} safety travel advisory"
   → Any recent news affecting travel to this destination?

2. HOLIDAYS & EVENTS: "${destCity} holidays festivals ${travelMonth}" AND "US holidays ${travelMonth}"
   → Major holidays, festivals, events during travel dates?

3. STRIKES & DISRUPTIONS: "${destCity} airport strikes" OR "${flight.destination} airline strikes 2026"
   → Any transportation strikes or disruptions?

4. CURRENCY & COSTS: "USD to EUR exchange rate" (or relevant currency) AND "${destCity} tourism costs"
   → Currency trends? Is destination expensive right now?

5. CULTURAL INFO: "${destCity} travel tips" OR "${destCity} what to know before visiting"
   → Store closures, customs, local tips?

TASK 3: ANALYZE & PREDICT
Based on ALL data (current price, historical prices, web research):
- Is current price GOOD, FAIR, or HIGH compared to history?
- Will prices likely GO UP, GO DOWN, or STAY STABLE?
- Should user BOOK NOW or WAIT?

═══════════════════════════════════════════════════════════════════════════════
OUTPUT FORMAT (respond with ONLY this JSON, no other text)
═══════════════════════════════════════════════════════════════════════════════
{
    "success": true,
    "price": {
        "current": <number>,
        "currency": "USD",
        "airline": "<airline name>",
        "vs_average": "<X% above/below average>" or "no history",
        "assessment": "good" | "fair" | "high"
    },
    "prediction": {
        "direction": "up" | "down" | "stable",
        "confidence": "high" | "medium" | "low",
        "recommendation": "book_now" | "wait" | "monitor",
        "reasoning": "<2-3 sentences explaining why>"
    },
    "context": {
        "news": "<1-2 sentence summary of relevant news>",
        "holidays": "<holidays/events during travel dates>",
        "strikes": "<any strikes or disruptions>",
        "currency": "<currency/cost situation>",
        "cultural": "<key cultural tips>"
    },
    "alerts": [
        "<important thing 1>",
        "<important thing 2>"
    ]
}

If you cannot complete a task, still return partial results with what you found.
`;
    }

    return `Check flight ${flight.origin} to ${flight.destination} on ${flight.departure_date}`;
}

async function runClaudeWithChrome(prompt) {
    return new Promise((resolve, reject) => {
        console.log('[LocalAgent] Running Claude CLI with Chrome...');

        const claude = spawn('claude', [
            '--chrome',
            '-p', prompt,
            '--dangerously-skip-permissions'
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        let stdout = '';
        let stderr = '';

        claude.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        claude.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        claude.on('close', (code) => {
            if (code !== 0) {
                console.error('[LocalAgent] Claude exited with code:', code);
                console.error('[LocalAgent] stderr:', stderr);
                reject(new Error(`Claude exited with code ${code}: ${stderr}`));
                return;
            }

            // Try to extract JSON from output
            try {
                // Look for JSON in the output
                const jsonMatch = stdout.match(/\{[\s\S]*"success"[\s\S]*\}/);
                if (jsonMatch) {
                    const result = JSON.parse(jsonMatch[0]);
                    resolve(result);
                } else {
                    console.log('[LocalAgent] Raw output:', stdout);
                    reject(new Error('No JSON found in Claude output'));
                }
            } catch (parseError) {
                console.log('[LocalAgent] Raw output:', stdout);
                reject(new Error(`Failed to parse Claude output: ${parseError.message}`));
            }
        });

        claude.on('error', (error) => {
            reject(new Error(`Failed to spawn Claude: ${error.message}`));
        });
    });
}

async function processJob(job) {
    console.log(`\n[LocalAgent] ═══════════════════════════════════════════════`);
    console.log(`[LocalAgent] Processing job #${job.id}: ${job.type}`);

    try {
        if (job.type === 'check_now') {
            const flight = await getFlightFromRailway(job.flight_id);
            if (!flight) {
                await completeJob(job.id, { status: 'error', error_text: 'Flight not found' });
                return;
            }

            console.log(`[LocalAgent] Flight: ${flight.name} (${flight.origin} → ${flight.destination})`);
            console.log(`[LocalAgent] Cabin: ${flight.cabin_class}, Date: ${flight.departure_date}`);

            const prompt = buildScrapePrompt(flight, 'check_now');
            const result = await runClaudeWithChrome(prompt);

            if (result.success) {
                console.log(`[LocalAgent] ✓ Found price: $${result.price} on ${result.airline}`);
                await completeJob(job.id, {
                    status: 'success',
                    result: {
                        price: result.price,
                        currency: result.currency || 'USD',
                        airline: result.airline,
                        source: result.source || 'google_flights_claude'
                    }
                });
            } else {
                console.log(`[LocalAgent] ✗ Failed: ${result.error}`);
                await completeJob(job.id, { status: 'error', error_text: result.error });
            }
        } else if (job.type === 'check_all') {
            // Get all active flights
            const response = await fetchWithAuth(`${RAILWAY_URL}/api/flights`);
            const flights = await response.json();

            const results = [];
            for (const flight of flights) {
                console.log(`[LocalAgent] Checking: ${flight.name}`);

                try {
                    const prompt = buildScrapePrompt(flight, 'check_now');
                    const result = await runClaudeWithChrome(prompt);

                    if (result.success) {
                        results.push({
                            flight_id: flight.id,
                            price: result.price,
                            currency: result.currency || 'USD',
                            airline: result.airline,
                            source: result.source || 'google_flights_claude'
                        });
                        console.log(`[LocalAgent] ✓ ${flight.name}: $${result.price}`);
                    }
                } catch (error) {
                    console.log(`[LocalAgent] ✗ ${flight.name}: ${error.message}`);
                }

                // Small delay between flights
                await new Promise(r => setTimeout(r, 2000));
            }

            await completeJob(job.id, { status: 'success', result: { results } });

        } else if (job.type === 'full_analysis') {
            // FULL TRAVEL INTELLIGENCE ANALYSIS
            // Gets current price + 5 web searches + prediction based on all data
            const flight = await getFlightFromRailway(job.flight_id);
            if (!flight) {
                await completeJob(job.id, { status: 'error', error_text: 'Flight not found' });
                return;
            }

            console.log(`[LocalAgent] ════════════════════════════════════════════════════`);
            console.log(`[LocalAgent] FULL ANALYSIS: ${flight.name}`);
            console.log(`[LocalAgent] Route: ${flight.origin} → ${flight.destination}`);
            console.log(`[LocalAgent] Cabin: ${flight.cabin_class}, Date: ${flight.departure_date}`);
            console.log(`[LocalAgent] ════════════════════════════════════════════════════`);

            // Fetch historical prices
            let historicalPrices = [];
            try {
                const pricesResp = await fetchWithAuth(`${RAILWAY_URL}/api/flights/${job.flight_id}/prices?days=90`);
                if (pricesResp.ok) {
                    historicalPrices = await pricesResp.json();
                    console.log(`[LocalAgent] Historical prices: ${historicalPrices.length} records`);
                }
            } catch (e) {
                console.log(`[LocalAgent] Could not fetch historical prices: ${e.message}`);
            }

            // Build the comprehensive prompt
            const prompt = buildScrapePrompt(flight, 'full_analysis', historicalPrices);

            console.log(`[LocalAgent] Running full analysis with Claude + Chrome...`);
            console.log(`[LocalAgent] This will: 1) Get Google Flights price 2) Do 5 web searches 3) Analyze & predict`);

            try {
                const result = await runClaudeWithChrome(prompt);

                if (result.success) {
                    console.log(`[LocalAgent] ✓ Analysis complete!`);
                    console.log(`[LocalAgent] Price: $${result.price?.current} (${result.price?.assessment})`);
                    console.log(`[LocalAgent] Prediction: ${result.prediction?.direction} - ${result.prediction?.recommendation}`);
                    console.log(`[LocalAgent] Reasoning: ${result.prediction?.reasoning}`);

                    await completeJob(job.id, {
                        status: 'success',
                        result: {
                            price: result.price?.current,
                            currency: result.price?.currency || 'USD',
                            airline: result.price?.airline,
                            source: 'full_analysis_claude',
                            analysis: result
                        }
                    });
                } else {
                    console.log(`[LocalAgent] ✗ Analysis failed: ${result.error}`);
                    await completeJob(job.id, { status: 'error', error_text: result.error });
                }
            } catch (error) {
                console.error(`[LocalAgent] Analysis error:`, error.message);
                await completeJob(job.id, { status: 'error', error_text: error.message });
            }

        } else {
            console.log(`[LocalAgent] Unknown job type: ${job.type}`);
            await completeJob(job.id, { status: 'error', error_text: `Unknown job type: ${job.type}` });
        }
    } catch (error) {
        console.error(`[LocalAgent] Job failed:`, error.message);
        await completeJob(job.id, { status: 'error', error_text: error.message });
    }
}

async function mainLoop() {
    console.log('[LocalAgent] Starting poll loop...\n');

    while (true) {
        const job = await pollForJob();

        if (job) {
            await processJob(job);
        } else {
            process.stdout.write('.');
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[LocalAgent] Shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n[LocalAgent] Terminated.');
    process.exit(0);
});

// Start the agent
mainLoop().catch(error => {
    console.error('[LocalAgent] Fatal error:', error);
    process.exit(1);
});
