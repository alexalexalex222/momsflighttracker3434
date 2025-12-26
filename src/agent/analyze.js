#!/usr/bin/env node

/**
 * Price Intelligence Analyzer
 *
 * Analyzes flight prices with web search to find:
 * - Events at destination affecting demand
 * - Airline/travel industry trends
 * - Actionable recommendations
 */

import 'dotenv/config';
import { getAllFlightsWithLatestPrice, getPriceHistory, getFlight, query } from '../db/postgres.js';

// Airport code to city mapping
const AIRPORT_CITIES = {
    'ATL': 'Atlanta', 'JFK': 'New York', 'LAX': 'Los Angeles', 'ORD': 'Chicago',
    'DFW': 'Dallas', 'MAD': 'Madrid Spain', 'BCN': 'Barcelona Spain',
    'CDG': 'Paris France', 'LHR': 'London UK', 'FCO': 'Rome Italy',
    'AMS': 'Amsterdam', 'FRA': 'Frankfurt Germany', 'LIS': 'Lisbon Portugal',
    'MIA': 'Miami', 'SFO': 'San Francisco', 'SEA': 'Seattle', 'BOS': 'Boston'
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

// Web search using DuckDuckGo (free, no API key)
async function webSearch(queryText) {
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(queryText)}&format=json&no_html=1`;
        const response = await fetch(url);
        const data = await response.json();
        return {
            query: queryText,
            abstract: data.Abstract || null,
            source: data.AbstractSource || null,
            url: data.AbstractURL || null,
            topics: (data.RelatedTopics || []).slice(0, 3).map(t => ({
                text: t.Text?.substring(0, 150),
                url: t.FirstURL
            })).filter(t => t.text)
        };
    } catch (error) {
        return { query: queryText, error: error.message };
    }
}

// Analyze price trend from history
function analyzePriceTrend(prices) {
    if (!prices || prices.length === 0) {
        return { trend: 'unknown', change: 0, current: null, lowest: null, highest: null };
    }

    const current = prices[0].price;
    const oldest = prices[prices.length - 1].price;
    const lowest = Math.min(...prices.map(p => p.price));
    const highest = Math.max(...prices.map(p => p.price));
    const average = Math.round(prices.reduce((s, p) => s + p.price, 0) / prices.length);
    const change = parseFloat(((current - oldest) / oldest * 100).toFixed(1));

    let trend = 'stable';
    if (change < -5) trend = 'dropping';
    else if (change > 5) trend = 'rising';

    return { trend, change, current, lowest, highest, average, dataPoints: prices.length };
}

// Generate search queries for a flight
function getSearchQueries(flight) {
    const dest = AIRPORT_CITIES[flight.destination] || flight.destination;
    const date = new Date(flight.departure_date);
    const month = MONTHS[date.getMonth()];
    const year = date.getFullYear();

    return [
        `${dest} events festivals ${month} ${year}`,
        `cheap flights to ${dest} ${year} deals`,
        `${dest} tourism travel tips ${month}`,
        `airline flight prices ${year} forecast trends`,
        `best time visit ${dest} weather tourism`
    ];
}

// Main analysis function
export async function analyzeFlightPrice(flightId) {
    // Get flight
    const flight = await getFlight(flightId);
    if (!flight) {
        throw new Error(`Flight ${flightId} not found`);
    }

    // Get prices
    const prices = await getPriceHistory(flightId, 30);

    const priceData = analyzePriceTrend(prices);
    const dest = AIRPORT_CITIES[flight.destination] || flight.destination;
    const travelDate = new Date(flight.departure_date);
    const daysUntil = Math.ceil((travelDate - new Date()) / (1000 * 60 * 60 * 24));

    console.log(`\nAnalyzing: ${flight.name}`);
    console.log(`Route: ${flight.origin} → ${flight.destination} (${dest})`);
    console.log(`Travel: ${flight.departure_date} (${daysUntil} days away)`);
    console.log(`Price: $${priceData.current || 'unknown'} | Trend: ${priceData.trend}`);

    // Run web searches
    const queries = getSearchQueries(flight);
    console.log(`\nSearching for insights...`);

    const insights = [];
    const sources = [];

    for (const q of queries) {
        const result = await webSearch(q);
        await new Promise(r => setTimeout(r, 300)); // Rate limit

        if (result.abstract) {
            insights.push({
                category: q.split(' ').slice(0, 2).join(' '),
                text: result.abstract.substring(0, 200),
                source: result.source,
                url: result.url
            });
            if (result.url) sources.push({ name: result.source, url: result.url });
        }

        for (const topic of result.topics || []) {
            if (topic.text) {
                insights.push({
                    category: 'Related',
                    text: topic.text,
                    url: topic.url
                });
            }
        }
    }

    // Generate recommendation
    let recommendation, action;
    if (priceData.trend === 'dropping') {
        action = 'CONSIDER BOOKING';
        recommendation = `Price trending down ${Math.abs(priceData.change)}%. Current $${priceData.current} is good value.`;
    } else if (priceData.trend === 'rising') {
        action = 'BOOK SOON';
        recommendation = `Price up ${priceData.change}%. Book now before further increases.`;
    } else if (daysUntil < 30) {
        action = 'BOOK NOW';
        recommendation = `Only ${daysUntil} days until travel. Prices typically rise closer to departure.`;
    } else {
        action = 'MONITOR';
        const target = Math.round((priceData.average || priceData.current) * 0.9);
        recommendation = `Price stable. Set alert for drops below $${target}.`;
    }

    // Build analysis object
    const analysis = {
        flightId,
        flightName: flight.name,
        route: `${flight.origin} → ${flight.destination}`,
        destination: dest,
        travelDate: flight.departure_date,
        returnDate: flight.return_date,
        daysUntil,
        analyzedAt: new Date().toISOString(),
        price: {
            current: priceData.current,
            lowest: priceData.lowest,
            highest: priceData.highest,
            average: priceData.average,
            trend: priceData.trend,
            change: priceData.change,
            dataPoints: priceData.dataPoints
        },
        action,
        recommendation,
        insights: insights.slice(0, 8),
        sources: [...new Map(sources.map(s => [s.url, s])).values()].slice(0, 5)
    };

    // Save to database (create table if needed)
    try {
        await query(`CREATE TABLE IF NOT EXISTS analyses (
            id SERIAL PRIMARY KEY,
            flight_id INTEGER NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
            analysis_json TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`);
        await query('INSERT INTO analyses (flight_id, analysis_json) VALUES ($1, $2)',
            [flightId, JSON.stringify(analysis)]);
        console.log('Analysis saved.');
    } catch (e) {
        console.log('Note: Could not save analysis:', e.message);
    }

    return analysis;
}

// Analyze all active flights
async function analyzeAllFlights() {
    const flights = await getAllFlightsWithLatestPrice();

    if (flights.length === 0) {
        console.log('No flights to analyze.');
        return [];
    }

    console.log(`Analyzing ${flights.length} flight(s)...\n`);
    const results = [];

    for (const flight of flights) {
        try {
            const analysis = await analyzeFlightPrice(flight.id);
            results.push(analysis);

            console.log(`\n${'─'.repeat(50)}`);
            console.log(`${analysis.action}: ${analysis.recommendation}`);
            if (analysis.insights.length > 0) {
                console.log(`\nTop insight: ${analysis.insights[0].text.substring(0, 100)}...`);
            }
        } catch (e) {
            console.error(`Failed to analyze ${flight.name}:`, e.message);
        }
    }

    return results;
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
    const arg = process.argv[2];

    if (arg === '--all' || !arg) {
        analyzeAllFlights()
            .then(results => {
                console.log(`\n${'='.repeat(50)}`);
                console.log(`Analyzed ${results.length} flight(s)`);
            })
            .catch(console.error);
    } else {
        const flightId = parseInt(arg);
        if (isNaN(flightId)) {
            console.log('Usage: node src/agent/analyze.js [flight_id|--all]');
            process.exit(1);
        }
        analyzeFlightPrice(flightId)
            .then(a => {
                console.log(`\n${'='.repeat(50)}`);
                console.log('PRICE INTELLIGENCE REPORT');
                console.log(`${'='.repeat(50)}`);
                console.log(`\n${a.action}: ${a.recommendation}`);
                console.log(`\nInsights: ${a.insights.length}`);
                console.log(`Sources: ${a.sources.length}`);
            })
            .catch(console.error);
    }
}

export { analyzeAllFlights };
