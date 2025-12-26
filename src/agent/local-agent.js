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
        // Calculate price statistics from historical data
        const prices = historicalPrices.map(p => p.price).filter(p => p > 0);
        const latestPrice = prices[0] || null;
        const avgPrice = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
        const minPrice = prices.length > 0 ? Math.min(...prices) : null;
        const maxPrice = prices.length > 0 ? Math.max(...prices) : null;

        const historyStr = historicalPrices.length > 0
            ? historicalPrices.slice(0, 10).map(p => `  - ${p.checked_at}: $${p.price} (${p.airline || 'Unknown'})`).join('\n')
            : '  No historical data yet';

        const statsStr = prices.length > 0
            ? `Latest: $${latestPrice} | Avg: $${avgPrice} | Low: $${minPrice} | High: $${maxPrice} | Data points: ${prices.length}`
            : 'No price data available';

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
PRICE HISTORY (from our tracking database)
═══════════════════════════════════════════════════════════════════════════════
${statsStr}

Recent prices:
${historyStr}

═══════════════════════════════════════════════════════════════════════════════
YOUR TASKS - Use WebSearch tool for ALL of these
═══════════════════════════════════════════════════════════════════════════════

TASK 1: WEB RESEARCH (do all 5 searches)
Use the WebSearch tool to find context that affects flight prices and travel:

1. Search: "${destCity} travel news December 2025 January 2026"
   → Any recent news affecting travel to this destination?

2. Search: "${destCity} holidays festivals ${travelMonth}"
   → Major holidays, festivals, events during travel dates?

3. Search: "${destCity} airport strikes transportation 2026"
   → Any transportation strikes or disruptions?

4. Search: "${destCity} tourism costs 2026 travel budget"
   → Is destination expensive right now? Currency situation?

5. Search: "${destCity} travel tips what to know"
   → Store closures, customs, local tips?

TASK 2: ANALYZE & PREDICT
Based on ALL data (historical prices + web research):
- Is the latest tracked price ($${latestPrice || 'unknown'}) GOOD, FAIR, or HIGH vs average ($${avgPrice || 'unknown'})?
- Based on demand factors (holidays, events, season), will prices GO UP, GO DOWN, or STAY STABLE?
- Should user BOOK NOW or WAIT?

═══════════════════════════════════════════════════════════════════════════════
OUTPUT FORMAT (respond with ONLY this JSON, no other text)
═══════════════════════════════════════════════════════════════════════════════
{
    "success": true,
    "price": {
        "latest_tracked": ${latestPrice || 'null'},
        "average": ${avgPrice || 'null'},
        "low": ${minPrice || 'null'},
        "high": ${maxPrice || 'null'},
        "currency": "USD",
        "vs_average": "${latestPrice && avgPrice ? (latestPrice > avgPrice ? `${Math.round((latestPrice - avgPrice) / avgPrice * 100)}% above average` : `${Math.round((avgPrice - latestPrice) / avgPrice * 100)}% below average`) : 'no data'}",
        "assessment": "good" | "fair" | "high"
    },
    "prediction": {
        "direction": "up" | "down" | "stable",
        "confidence": "high" | "medium" | "low",
        "recommendation": "book_now" | "wait" | "monitor",
        "reasoning": "<2-3 sentences explaining why based on your research>"
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

IMPORTANT: Do the web searches FIRST, then analyze. Return partial results if some searches fail.
`;
    }

    return `Check flight ${flight.origin} to ${flight.destination} on ${flight.departure_date}`;
}

async function runClaudeAnalysis(prompt) {
    return new Promise((resolve, reject) => {
        console.log('[LocalAgent] Running Claude CLI with WebSearch...');

        // Claude CLI has built-in WebSearch tool - no browser needed for research!
        // The WebSearch tool uses Anthropic's search API, no CAPTCHA issues.
        // IMPORTANT: Use full path to Claude binary - the alias doesn't work in subprocess
        const claudePath = process.env.HOME + '/.claude/local/node_modules/.bin/claude';
        console.log('[LocalAgent] Claude path:', claudePath);
        console.log('[LocalAgent] Prompt length:', prompt.length);

        const claude = spawn(claudePath, [
            '--model', 'sonnet',  // Use sonnet for cost efficiency
            '-p', prompt,
            '--dangerously-skip-permissions',
            '--output-format', 'json'
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        console.log('[LocalAgent] Spawned Claude subprocess, PID:', claude.pid);

        // Close stdin immediately - Claude CLI doesn't need interactive input
        claude.stdin.end();

        let stdout = '';
        let stderr = '';

        claude.stdout.on('data', (data) => {
            // Log progress for long-running analysis
            console.log('[LocalAgent] Received', data.length, 'bytes from Claude');
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

            // Parse JSON output from Claude CLI
            try {
                // With --output-format json, Claude returns an array of message objects
                // We need to find the "result" type object for the final response
                const messages = JSON.parse(stdout);

                // Find the result message
                const resultMsg = Array.isArray(messages)
                    ? messages.find(m => m.type === 'result')
                    : messages;

                if (!resultMsg) {
                    console.log('[LocalAgent] No result message found');
                    reject(new Error('No result message in Claude output'));
                    return;
                }

                // The result text is in resultMsg.result
                const resultText = resultMsg.result || '';

                // Look for our expected JSON in the result text
                const jsonMatch = String(resultText).match(/\{[\s\S]*"success"[\s\S]*\}/);
                if (jsonMatch) {
                    const result = JSON.parse(jsonMatch[0]);
                    resolve(result);
                } else {
                    // If no structured JSON found, return the raw response with context
                    console.log('[LocalAgent] No structured JSON, returning raw response');
                    resolve({
                        success: true,
                        raw: resultText,
                        source: 'claude_analysis'
                    });
                }
            } catch (parseError) {
                console.log('[LocalAgent] Parse error:', parseError.message);
                console.log('[LocalAgent] Raw output (first 1000 chars):', stdout.substring(0, 1000));
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
            const result = await runClaudeAnalysis(prompt);

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
                    const result = await runClaudeAnalysis(prompt);

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

            console.log(`[LocalAgent] Running full analysis with Claude + WebSearch...`);
            console.log(`[LocalAgent] This will: 1) Do 5 web searches 2) Analyze historical prices 3) Predict & recommend`);

            try {
                const result = await runClaudeAnalysis(prompt);

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
