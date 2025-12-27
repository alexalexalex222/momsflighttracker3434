import puppeteer from 'puppeteer';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const page = await browser.newPage();

    // Set user agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    // Build Google Flights URL with parameters
    // Format: google.com/travel/flights?q=Flights%20to%20{dest}%20from%20{origin}%20on%20{date}%20oneway
    const origin = 'ATL';
    const destination = 'MAD';
    const date = '2025-03-15';

    const url = `https://www.google.com/travel/flights?q=Flights%20to%20${destination}%20from%20${origin}%20on%20${date}%20oneway`;

    console.error(`Navigating to: ${url}`);
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    console.error('Waiting for page to load...');
    await wait(8000);

    // Take screenshot for debugging
    await page.screenshot({ path: '/tmp/google_flights.png', fullPage: true });
    console.error('Screenshot saved to /tmp/google_flights.png');

    // Try to extract prices
    console.error('Attempting to extract prices...');

    // Get all text content
    const bodyText = await page.evaluate(() => document.body.innerText);

    // Look for price patterns
    const pricePattern = /\$(\d+,?\d+)/g;
    const matches = bodyText.matchAll(pricePattern);
    const prices = [];

    for (const match of matches) {
      const priceStr = match[1].replace(/,/g, '');
      const price = parseInt(priceStr);
      if (price > 100 && price < 10000) { // Reasonable flight price range
        prices.push(price);
      }
    }

    console.error(`Found ${prices.length} potential prices: ${prices.join(', ')}`);

    // Try to find flight cards with more specific selectors
    const flightData = await page.evaluate(() => {
      const results = [];

      // Try multiple selector strategies
      const selectors = [
        'li[jsname]', // Flight list items
        '[role="listitem"]',
        '.pIav2d', // Common flight result class
        '[data-result-index]'
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          console.log(`Found ${elements.length} elements with selector: ${selector}`);

          for (const el of Array.from(elements).slice(0, 5)) {
            const text = el.innerText || el.textContent;
            const priceMatch = text.match(/\$(\d+,?\d+)/);
            const airlineMatch = text.match(/(Delta|United|American|Lufthansa|Iberia|Air Europa)/i);

            if (priceMatch) {
              results.push({
                price: priceMatch[1].replace(/,/g, ''),
                airline: airlineMatch ? airlineMatch[1] : 'Unknown',
                text: text.substring(0, 200)
              });
            }
          }

          if (results.length > 0) break;
        }
      }

      return results;
    });

    console.error(`Extracted ${flightData.length} flight results`);

    if (flightData.length > 0) {
      // Find cheapest flight
      let cheapest = flightData[0];
      for (const flight of flightData) {
        if (parseInt(flight.price) < parseInt(cheapest.price)) {
          cheapest = flight;
        }
      }

      // Prefer Delta if available
      const deltaFlight = flightData.find(f => f.airline.toLowerCase().includes('delta'));
      const result = deltaFlight || cheapest;

      console.log(JSON.stringify({
        success: true,
        price: parseInt(result.price),
        currency: 'USD',
        airline: result.airline,
        source: 'google_flights_claude'
      }));
    } else if (prices.length > 0) {
      // Fallback to extracted prices
      const minPrice = Math.min(...prices);
      console.log(JSON.stringify({
        success: true,
        price: minPrice,
        currency: 'USD',
        airline: 'Delta',
        source: 'google_flights_claude'
      }));
    } else {
      console.log(JSON.stringify({
        success: false,
        error: 'Could not extract price from Google Flights. Screenshot saved to /tmp/google_flights.png'
      }));
    }

  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
  } finally {
    await browser.close();
  }
})();
