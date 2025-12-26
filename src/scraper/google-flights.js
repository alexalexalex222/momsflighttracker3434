import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { accessSync, constants } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
import { getActiveFlights, savePrice } from '../db/postgres.js';

puppeteer.use(StealthPlugin());

function resolveExecutablePath(candidate) {
    if (!candidate) return null;
    const c = String(candidate).trim();
    if (!c) return null;
    if (c === ':memory:') return c;

    // Puppeteer expects an absolute path. If we were given a command name,
    // resolve it from PATH.
    if (!isAbsolute(c) && !c.includes('/')) {
        const pathEnv = process.env.PATH || '';
        for (const dir of pathEnv.split(delimiter)) {
            if (!dir) continue;
            const full = join(dir, c);
            try {
                accessSync(full, constants.X_OK);
                return full;
            } catch {
                // continue
            }
        }
    }

    return c;
}

function getBrowserExecutableCandidates() {
    const candidates = [];

    const envCandidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROME_BIN,
        process.env.CHROMIUM_BIN
    ].filter(Boolean).map(s => String(s).trim()).filter(Boolean);

    candidates.push(...envCandidates);

    // Common names on PATH in container environments (nixpacks, apt, etc)
    candidates.push('chromium');
    candidates.push('google-chrome-stable');
    candidates.push('google-chrome');
    candidates.push('chromium-browser');

    // Common absolute paths (last-resort)
    candidates.push('/usr/bin/chromium');
    candidates.push('/usr/bin/google-chrome');
    candidates.push('/usr/bin/chromium-browser');

    return [...new Set(candidates)];
}

async function launchBrowser() {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled'
    ];

    const errors = [];

    // First try: let puppeteer pick (works if Chromium was downloaded during install)
    try {
        const browser = await puppeteer.launch({ headless: 'new', args });
        console.log('[Scraper] Browser launched (bundled Chromium)');
        return browser;
    } catch (e) {
        errors.push({ candidate: '(bundled)', error: e?.message || String(e) });
    }

    // Next: try known executables
    for (const executablePath of getBrowserExecutableCandidates()) {
        const resolved = resolveExecutablePath(executablePath);
        if (!resolved) continue;
        try {
            const browser = await puppeteer.launch({ headless: 'new', executablePath: resolved, args });
            console.log(`[Scraper] Browser launched (${resolved})`);
            return browser;
        } catch (e) {
            const message = e?.message || String(e);
            errors.push({ candidate: resolved, error: message });
        }
    }

    const details = errors
        .slice(0, 6)
        .map(x => `${x.candidate}: ${x.error.split('\n')[0]}`)
        .join(' | ');

    const hint =
        'Unable to launch Chromium. ' +
        'On Railway + nixpacks, install chromium and set PUPPETEER_EXECUTABLE_PATH=chromium (not /usr/bin/chromium-browser).';

    throw new Error(`${hint}\nTried: ${details}`);
}

// Map cabin class to Google Flights cabin code
// 1 = Economy, 2 = Premium Economy, 3 = Business, 4 = First
function getCabinCode(cabinClass) {
    switch ((cabinClass || '').toLowerCase()) {
        case 'premium_economy':
            return 2;
        case 'business':
            return 3;
        case 'first':
            return 4;
        case 'economy':
        default:
            return 1;
    }
}

function getCabinName(cabinClass) {
    switch ((cabinClass || '').toLowerCase()) {
        case 'premium_economy':
            return 'Premium Economy';
        case 'business':
            return 'Business';
        case 'first':
            return 'First';
        case 'economy':
        default:
            return 'Economy';
    }
}

function buildGoogleFlightsUrl(flight) {
    const { origin, destination, departure_date, return_date, passengers, cabin_class } = flight;

    // Format: /travel/flights?q=ATL+to+MAD&curr=USD
    // With date format for the search
    const depDate = departure_date; // YYYY-MM-DD
    const cabinCode = getCabinCode(cabin_class);
    const pax = Number.isFinite(passengers) ? Math.max(1, passengers) : 1;

    // Build a simple query that Google understands
    let query = `${origin} to ${destination} ${depDate}`;
    if (return_date) {
        query += ` to ${return_date}`;
    }

    // Add cabin class and passengers to query
    const cabinName = getCabinName(cabin_class);
    query += ` ${pax} passenger ${cabinName}`;

    return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}&curr=USD`;
}

// Scrape a single flight from Google Flights
async function scrapeFlight(browser, flight) {
    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 1400, height: 900 });
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const { origin, destination, cabin_class } = flight;
        const prefersDelta = String(flight.preferred_airline || '').toLowerCase() === 'delta';
        const cabinName = getCabinName(cabin_class);
        const url = buildGoogleFlightsUrl(flight);

        console.log(`[Scraper] ${flight.name}: ${origin} → ${destination} (${cabinName})`);
        console.log(`[Scraper] URL: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait for page to render (longer for premium cabins)
        const isPremiumCabin = ['business', 'first', 'premium_economy'].includes((cabin_class || '').toLowerCase());
        const waitTime = isPremiumCabin ? 6000 : 4000;
        await new Promise(r => setTimeout(r, waitTime));

        // Take a screenshot for debugging (can be disabled in production)
        await page.screenshot({ path: `/tmp/flight-${flight.id}.png`, fullPage: false });

        // Try to click through to search results if we're on explore page
        const exploreBtn = await page.$('button[aria-label="Explore"]');
        if (exploreBtn) {
            await exploreBtn.click();
            await new Promise(r => setTimeout(r, 3000));
        }

        // Extract price and airline from page - look for flight cards
        const result = await page.evaluate(() => {
            let deltaPrice = null;
            let cheapestPrice = null;
            let cheapestAirline = null;

            // Find all flight result rows/cards
            const flightCards = document.querySelectorAll('li[data-ved], [jsname] ul > li, .pIav2d, .Rk10dc');

            // Also look at the raw text for price patterns near airline names
            const pageText = document.body.innerText;
            const lines = pageText.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                // Look for Delta flight with price
                if (line.includes('Delta') || (lines[i-1] && lines[i-1].includes('Delta'))) {
                    // Look for price in nearby lines
                    for (let j = Math.max(0, i-3); j < Math.min(lines.length, i+5); j++) {
                        const priceMatch = lines[j].match(/\$(\d{1,3}(?:,\d{3})*)/);
                        if (priceMatch) {
                            const p = parseInt(priceMatch[1].replace(',', ''));
                            if (p >= 100 && p <= 50000) {
                                if (!deltaPrice || p < deltaPrice) {
                                    deltaPrice = p;
                                }
                            }
                        }
                    }
                }
            }

            // Get all prices and cheapest
            const allPrices = [];
            const priceRegex = /\$(\d{1,3}(?:,\d{3})*)/g;
            let match;
            while ((match = priceRegex.exec(pageText)) !== null) {
                const p = parseInt(match[1].replace(',', ''));
                if (p >= 50 && p <= 50000) {
                    allPrices.push(p);
                }
            }

            if (allPrices.length > 0) {
                allPrices.sort((a, b) => a - b);
                cheapestPrice = allPrices[0];
            }

            // Determine airline for cheapest
            const airlines = ['JetBlue', 'Delta', 'United', 'American', 'Southwest', 'Spirit', 'Frontier', 'Alaska', 'Turkish', 'Iberia', 'British Airways', 'Lufthansa', 'Air France'];
            for (const name of airlines) {
                if (pageText.includes(name)) {
                    cheapestAirline = name;
                    break;
                }
            }

            return {
                deltaPrice,
                cheapestPrice,
                cheapestAirline,
                foundPrices: allPrices.slice(0, 8)
            };
        });

        // Prefer Delta price only when requested, otherwise use cheapest
        const finalPrice = (prefersDelta && result.deltaPrice) ? result.deltaPrice : result.cheapestPrice;
        const finalAirline = (prefersDelta && result.deltaPrice) ? 'Delta' : result.cheapestAirline;

        await page.close();

        if (finalPrice) {
            console.log(`[Scraper] Found: $${finalPrice} (${finalAirline}) | Delta: $${result.deltaPrice || 'N/A'} | Cheapest: $${result.cheapestPrice} | All: ${result.foundPrices.join(', ')}`);
            return { price: finalPrice, airline: finalAirline, success: true, raw_data: result };
        } else {
            console.log(`[Scraper] No price found for ${flight.name}`);
            return { success: false, error: 'No prices found on page' };
        }

    } catch (error) {
        console.error(`[Scraper] Error: ${error.message}`);
        try { await page.close(); } catch (e) {}
        return { success: false, error: error.message };
    }
}

export async function getGoogleFlightQuote(flight, browser = null) {
    const ownBrowser = !browser;
    const activeBrowser = browser || await launchBrowser();

    try {
        const result = await scrapeFlight(activeBrowser, flight);
        if (!result.success) {
            throw new Error(result.error || 'No prices found on page');
        }

        return {
            price: result.price,
            airline: result.airline,
            currency: 'USD',
            source: 'google_flights',
            raw_data: result.raw_data
        };
    } finally {
        if (ownBrowser) {
            await activeBrowser.close();
        }
    }
}

// Main scrape function
export async function scrapeAllFlights() {
    console.log('[Scraper] Starting flight price check...');

    const flights = await getActiveFlights();

    if (flights.length === 0) {
        console.log('[Scraper] No flights to check');
        return { success: true, flights: 0, results: [] };
    }

    console.log(`[Scraper] Checking ${flights.length} flight(s)...`);

    const browser = await launchBrowser();

    const results = [];

    for (const flight of flights) {
        const result = await scrapeFlight(browser, flight);

        if (result.success && result.price) {
            // Save to database
            await savePrice({
                flight_id: flight.id,
                price: result.price,
                currency: 'USD',
                airline: result.airline
            });

            results.push({
                flight_id: flight.id,
                name: flight.name,
                price: result.price,
                airline: result.airline,
                success: true
            });
        } else {
            results.push({
                flight_id: flight.id,
                name: flight.name,
                success: false,
                error: result.error
            });
        }

        // Delay between requests
        await new Promise(r => setTimeout(r, 2000));
    }

    await browser.close();

    console.log('[Scraper] Complete!');
    return { success: true, flights: flights.length, results };
}
