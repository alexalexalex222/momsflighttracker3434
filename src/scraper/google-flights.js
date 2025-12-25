import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getDb } from '../db/setup.js';

puppeteer.use(StealthPlugin());

// Scrape a single flight from Google Flights
async function scrapeFlight(browser, flight) {
    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 1400, height: 900 });
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const { origin, destination, departure_date, return_date, preferred_airline } = flight;

        // Format the dates
        const depDate = departure_date.replace(/-/g, '-');
        const retDate = return_date ? return_date.replace(/-/g, '-') : null;

        // Build search query - add airline filter if specified
        let query = `Flights from ${origin} to ${destination} on ${depDate}`;
        if (retDate) {
            query += ` returning ${retDate}`;
        }
        if (preferred_airline && preferred_airline !== 'any') {
            query += ` ${preferred_airline}`;  // Add airline to search
        }

        const url = `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}&curr=USD`;

        console.log(`[Scraper] ${flight.name}: ${origin} → ${destination}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait for page to render
        await new Promise(r => setTimeout(r, 4000));

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
                            if (p >= 100 && p <= 20000) {
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
                if (p >= 50 && p <= 20000) {
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

        // Prefer Delta price, fall back to cheapest
        const finalPrice = result.deltaPrice || result.cheapestPrice;
        const finalAirline = result.deltaPrice ? 'Delta' : result.cheapestAirline;

        await page.close();

        if (finalPrice) {
            console.log(`[Scraper] Found: $${finalPrice} (${finalAirline}) | Delta: $${result.deltaPrice || 'N/A'} | Cheapest: $${result.cheapestPrice} | All: ${result.foundPrices.join(', ')}`);
            return { price: finalPrice, airline: finalAirline, success: true };
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

// Main scrape function
export async function scrapeAllFlights() {
    console.log('[Scraper] Starting flight price check...');
    const db = getDb();

    const flights = db.prepare(`
        SELECT id, name, origin, destination, departure_date, return_date, passengers, cabin_class, preferred_airline
        FROM flights WHERE is_active = 1
    `).all();

    if (flights.length === 0) {
        console.log('[Scraper] No flights to check');
        db.close();
        return { success: true, flights: 0, results: [] };
    }

    console.log(`[Scraper] Checking ${flights.length} flight(s)...`);

    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const results = [];

    for (const flight of flights) {
        const result = await scrapeFlight(browser, flight);

        if (result.success && result.price) {
            // Save to database
            db.prepare(`
                INSERT INTO prices (flight_id, price, currency, airline)
                VALUES (?, ?, 'USD', ?)
            `).run(flight.id, result.price, result.airline);

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
    db.close();

    console.log('[Scraper] Complete!');
    return { success: true, flights: flights.length, results };
}
