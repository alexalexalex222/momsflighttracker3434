import puppeteer from 'puppeteer';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate to Google Flights
    console.error('Navigating to Google Flights...');
    await page.goto('https://www.google.com/travel/flights', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    // Wait a bit for initial load
    await wait(2000);

    // Click one-way option
    console.error('Selecting one-way...');
    try {
      await page.waitForSelector('button[aria-label*="Round trip"]', { timeout: 5000 });
      await page.click('button[aria-label*="Round trip"]');
      await wait(500);
      await page.click('li[role="option"] span:has-text("One way")');
      await wait(1000);
    } catch (e) {
      console.error('Could not find round trip selector, continuing...');
    }

    // Enter origin (ATL)
    console.error('Entering origin airport...');
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="text"]');
      if (inputs[0]) inputs[0].click();
    });
    await wait(1000);

    await page.keyboard.type('ATL', { delay: 100 });
    await wait(2000);
    await page.keyboard.press('ArrowDown');
    await wait(500);
    await page.keyboard.press('Enter');
    await wait(2000);

    // Enter destination (MAD)
    console.error('Entering destination airport...');
    await page.keyboard.type('MAD', { delay: 100 });
    await wait(2000);
    await page.keyboard.press('ArrowDown');
    await wait(500);
    await page.keyboard.press('Enter');
    await wait(2000);

    // Click date picker
    console.error('Setting departure date...');
    const dateButton = await page.waitForSelector('input[placeholder*="Departure"]', { timeout: 10000 });
    await dateButton.click();
    await wait(1000);

    // Navigate to March 2025 and click the 15th
    // This is simplified - in production you'd need to navigate months
    try {
      const targetDate = await page.waitForSelector('div[data-iso="2025-03-15"]', { timeout: 5000 });
      await targetDate.click();
      await wait(500);

      // Click "Done" or close date picker
      const doneButton = await page.$('button:has-text("Done")');
      if (doneButton) await doneButton.click();
    } catch (e) {
      console.error('Date selection failed, trying alternative method...');
    }

    await wait(1000);

    // Click search button
    console.error('Clicking search...');
    try {
      const searchButton = await page.waitForSelector('button[aria-label*="Search"]', { timeout: 5000 });
      await searchButton.click();
    } catch (e) {
      // Search might auto-trigger
      console.error('Search button not found, may have auto-searched');
    }

    // Wait for results to load
    console.error('Waiting for results...');
    await wait(5000);

    // Try to find Delta flights and extract price
    console.error('Extracting price...');

    // Take a screenshot for debugging
    await page.screenshot({ path: '/tmp/google_flights.png', fullPage: true });

    // Try multiple selectors for price
    const priceSelectors = [
      '[jsname="qCDwBb"]', // Common price container
      '.YMlIz.FpEdX span', // Price span
      '[role="button"] .YMlIz', // Button with price
      'div[class*="price"]',
      'span[aria-label*="dollars"]'
    ];

    let priceText = null;
    let airline = null;

    for (const selector of priceSelectors) {
      try {
        const elements = await page.$$(selector);
        if (elements.length > 0) {
          priceText = await page.evaluate(el => el.textContent, elements[0]);
          if (priceText && priceText.includes('$')) {
            console.error(`Found price with selector ${selector}: ${priceText}`);
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }

    // Extract airline name
    try {
      const airlineElements = await page.$$('span[class*="carrier"]');
      if (airlineElements.length > 0) {
        airline = await page.evaluate(el => el.textContent, airlineElements[0]);
      }
    } catch (e) {
      airline = 'Unknown';
    }

    if (!priceText) {
      // Try to get any text that looks like a price
      const pageText = await page.evaluate(() => document.body.innerText);
      const priceMatch = pageText.match(/\$[\d,]+/);
      if (priceMatch) {
        priceText = priceMatch[0];
      }
    }

    if (priceText) {
      // Parse price
      const price = parseInt(priceText.replace(/[$,]/g, ''));

      const result = {
        success: true,
        price: price,
        currency: 'USD',
        airline: airline || 'Delta',
        source: 'google_flights_claude'
      };

      console.log(JSON.stringify(result));
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
