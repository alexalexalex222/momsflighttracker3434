import cron from 'node-cron';
import {
    getActiveFlights,
    savePrice,
    updateFlightCheckStatus,
    createJob,
    getBestFlexPrice,
    getContext,
    upsertContext,
    query
} from '../db/postgres.js';
import { sendPriceDropAlert } from '../notifications/email.js';
import { analyzeFlightPrice } from '../agent/analyze.js';
import { fetchTravelContext } from '../context/context.js';
import { getScheduleInfo } from './schedule.js';
import { getPriceQuote } from '../pricing/engine.js';

// Check prices and send updates
async function checkAndSendPriceUpdates() {
    console.log('\n[Scheduler] Running scheduled price check...');
    try {
        const localAgentEnabled = ['1', 'true', 'yes'].includes(String(process.env.LOCAL_AGENT_ENABLED || '').toLowerCase());
        if (localAgentEnabled) {
            const flights = await getActiveFlights();
            const payload = { origin: 'scheduler', requested_at: new Date().toISOString() };
            await createJob({ type: 'check_all', progress_total: flights.length, payload_json: JSON.stringify(payload) });

            for (const flight of flights) {
                if (!flight.notify_email) continue;
                await createJob({
                    type: 'send_email',
                    flight_id: flight.id,
                    progress_total: 1,
                    payload_json: JSON.stringify({ ...payload, flight_id: flight.id })
                });
            }

            console.log(`[Scheduler] Enqueued ${flights.length} check(s) + email jobs for local agent`);
            return;
        }

        // First, update latest prices (Amadeus primary, Google fallback)
        console.log('[Scheduler] Refreshing prices...');
        const flightsToCheck = await getActiveFlights();

        for (const flight of flightsToCheck) {
            try {
                const quote = await getPriceQuote(flight);
                await savePrice({
                    flight_id: flight.id,
                    price: quote.price,
                    currency: quote.currency || 'USD',
                    airline: quote.airline || null,
                    raw_data: quote.raw_data || null,
                    source: quote.source || null
                });
                await updateFlightCheckStatus(flight.id, 'ok', null);
            } catch (error) {
                const message = error?.message || String(error);
                await updateFlightCheckStatus(flight.id, 'error', message);
            }
        }

        // Get all active flights with prices
        const result = await query(`
            SELECT
                f.id, f.name, f.origin, f.destination, f.notify_email, f.departure_date,
                f.return_date, f.cabin_class, f.passengers, f.preferred_airline,
                (SELECT price FROM prices WHERE flight_id = f.id ORDER BY checked_at DESC LIMIT 1) as current_price,
                (SELECT price FROM prices WHERE flight_id = f.id ORDER BY checked_at DESC LIMIT 1 OFFSET 1) as previous_price,
                (SELECT MIN(price) FROM prices WHERE flight_id = f.id) as lowest_price,
                (SELECT airline FROM prices WHERE flight_id = f.id ORDER BY checked_at DESC LIMIT 1) as airline
            FROM flights f
            WHERE f.is_active = 1 AND f.notify_email IS NOT NULL
        `);
        const flights = result.rows;

        for (const flight of flights) {
            if (!flight.current_price) continue;

            console.log(`[Scheduler] Sending update for ${flight.name}: $${flight.current_price}`);

            // Get analysis for insights
            let analysis = null;
            try {
                analysis = await analyzeFlightPrice(flight.id);
            } catch (e) {
                console.log('[Scheduler] Analysis unavailable:', e.message);
            }

            // Flex suggestion (cached best price)
            const bestFlex = await getBestFlexPrice({
                flight_id: flight.id,
                maxAgeHours: 12,
                cabin_class: flight.cabin_class,
                passengers: flight.passengers || 1
            });
            let flexSuggestion = null;
            if (bestFlex && bestFlex.price) {
                const savings = flight.current_price && bestFlex.price
                    ? Math.max(0, Math.round(flight.current_price - bestFlex.price))
                    : null;
                flexSuggestion = {
                    price: bestFlex.price,
                    departure_date: bestFlex.departure_date,
                    return_date: bestFlex.return_date,
                    savings
                };
            }

            // Context cache
            let context = null;
            const cachedContext = await getContext({ flight_id: flight.id, maxAgeHours: 6 });
            if (cachedContext?.context_json) {
                try {
                    context = JSON.parse(cachedContext.context_json);
                } catch (e) {
                    context = null;
                }
            }

            if (!context) {
                try {
                    context = await fetchTravelContext(flight);
                    await upsertContext({
                        flight_id: flight.id,
                        context_json: JSON.stringify(context),
                        expires_at: context.expires_at || null
                    });
                } catch (e) {
                    console.log('[Scheduler] Context unavailable:', e.message);
                }
            }

            const scheduleInfo = getScheduleInfo();

            await sendPriceDropAlert({
                to: flight.notify_email,
                flightName: flight.name,
                route: `${flight.origin} → ${flight.destination}`,
                currentPrice: flight.current_price,
                previousPrice: flight.previous_price || flight.current_price,
                lowestPrice: flight.lowest_price || flight.current_price,
                airline: flight.airline || 'Delta',
                analysis,
                flexSuggestion,
                context,
                nextRunAt: scheduleInfo.nextRunAt
            });

            console.log(`[Scheduler] Email sent to ${flight.notify_email}`);
        }

        console.log('[Scheduler] All updates sent!');
    } catch (error) {
        console.error('[Scheduler] Error:', error.message);
    }
}

// Start the scheduler
export function startScheduler() {
    // Run every 6 hours - scrape prices and send email updates
    const schedule = process.env.CRON_SCHEDULE || '0 */6 * * *';
    const timezone = process.env.CRON_TZ || 'America/New_York';

    cron.schedule(schedule, () => {
        checkAndSendPriceUpdates();
    }, { timezone });

    console.log(`[Scheduler] Started - schedule ${schedule} (${timezone})`);
}

// Export for manual testing
export { checkAndSendPriceUpdates };
