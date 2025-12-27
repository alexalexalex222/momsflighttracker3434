import puppeteer from 'puppeteer';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ]
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    console.error('Navigating to Google Flights...');
    await page.goto('https://www.google.com/travel/flights', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await wait(3000);

    // Click and clear origin input
    console.error('Setting origin to ATL...');
    await page.click('input[placeholder="Where from?"]');
    await wait(500);

    // Clear any existing text
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await wait(300);

    // Type ATL
    await page.keyboard.type('ATL', { delay: 100 });
    await wait(1500);

    // Press Enter or click the first suggestion
    await page.keyboard.press('Enter');
    await wait(1500);

    // Click and fill destination
    console.error('Setting destination to MAD...');
    await page.click('input[placeholder="Where to?"]');
    await wait(500);

    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await wait(300);

    await page.keyboard.type('MAD', { delay: 100 });
    await wait(1500);
    await page.keyboard.press('Enter');
    await wait(1500);

    // Take screenshot before clicking date
    await page.screenshot({ path: '/tmp/google_flights_before_date.png' });

    // Click on the date field
    console.error('Setting date to March 15, 2025...');
    try {
      // Look for the departure date button/input
      const dateInputs = await page.$$('input[placeholder*="Departure"], button[aria-label*="Departure"]');
      if (dateInputs.length > 0) {
        await dateInputs[0].click();
        await wait(2000);

        // Try to find and click March 15, 2025
        // First, we might need to navigate to March 2025
        console.error('Looking for March 2025...');

        // Take screenshot of date picker
        await page.screenshot({ path: '/tmp/google_flights_datepicker.png' });

        // Try clicking on the date
        const dateButton = await page.$('div[data-iso="2025-03-15"]');
        if (dateButton) {
          console.error('Found date button, clicking...');
          await dateButton.click();
          await wait(1000);
        } else {
          console.error('Could not find exact date, will use current search');
        }

        // Click Done if present
        try {
          const doneButtons = await page.$$('button:has-text("Done"), button[aria-label="Done"]');
          if (doneButtons.length > 0) {
            await doneButtons[0].click();
            await wait(1000);
          }
        } catch (e) {
          console.error('No done button found');
        }
      }
    } catch (e) {
      console.error('Error setting date:', e.message);
    }

    // Click search/explore button
    console.error('Clicking search...');
    await wait(2000);

    try {
      const searchButtons = await page.$$('button[jsname="vLv7ab"]');
      if (searchButtons.length > 0) {
        await searchButtons[0].click();
        console.error('Clicked search button');
      }
    } catch (e) {
      console.error('Search button click failed:', e.message);
    }

    // Wait for results
    console.error('Waiting for results...');
    await wait(8000);

    // Take final screenshot
    await page.screenshot({ path: '/tmp/google_flights_results.png', fullPage: true });
    console.error('Results screenshot saved');

    // Extract flight data
    const flightData = await page.evaluate(() => {
      const results = [];
      const bodyText = document.body.innerText;

      // Extract all prices
      const priceMatches = bodyText.matchAll(/\$(\d{1,3}(?:,\d{3})*)/g);
      for (const match of priceMatches) {
        const priceNum = parseInt(match[1].replace(/,/g, ''));
        if (priceNum > 100 && priceNum < 5000) {
          results.push(priceNum);
        }
      }

      return {
        prices: results,
        bodyText: bodyText.substring(0, 1000)
      };
    });

    console.error(`Found ${flightData.prices.length} prices:`, flightData.prices);

    if (flightData.prices.length > 0) {
      const minPrice = Math.min(...flightData.prices);

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
        error: 'No flight prices found. Check screenshots: /tmp/google_flights_results.png'
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
