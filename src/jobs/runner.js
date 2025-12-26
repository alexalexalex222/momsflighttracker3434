import {
    createJob,
    updateJob,
    getActiveFlights,
    getFlight,
    savePrice,
    updateFlightCheckStatus,
    upsertFlexPrice,
    upsertContext
} from '../db/postgres.js';
import { getPriceQuote } from '../pricing/engine.js';
import { fetchTravelContext } from '../context/context.js';

let jobQueue = Promise.resolve();

function enqueue(fn) {
    jobQueue = jobQueue.then(fn).catch(err => {
        console.error('[Jobs] Queue error:', err);
    });
    return jobQueue;
}

function nowIso() {
    return new Date().toISOString();
}

async function runCheckForFlight(jobId, flight) {
    await updateJob(jobId, { status: 'running', started_at: nowIso() });
    await updateFlightCheckStatus(flight.id, 'running', null);

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
        await updateJob(jobId, {
            status: 'success',
            progress_current: 1,
            progress_total: 1,
            result_json: JSON.stringify({
                price: quote.price,
                currency: quote.currency || 'USD',
                airline: quote.airline || null,
                source: quote.source || 'unknown'
            }),
            finished_at: nowIso()
        });
    } catch (error) {
        const message = error?.message || String(error);
        await updateFlightCheckStatus(flight.id, 'error', message);
        await updateJob(jobId, {
            status: 'error',
            error_text: message,
            finished_at: nowIso()
        });
    }
}

export function runCheckNowJob(jobId, flightId) {
    enqueue(async () => {
        const flight = await getFlight(flightId);
        if (!flight) {
            await updateJob(jobId, {
                status: 'error',
                error_text: 'Flight not found',
                finished_at: nowIso()
            });
            return;
        }

        await runCheckForFlight(jobId, flight);
    });
}

export function runCheckAllJob(jobId) {
    enqueue(async () => {
        const flights = await getActiveFlights();
        await updateJob(jobId, {
            status: 'running',
            started_at: nowIso(),
            progress_total: flights.length,
            progress_current: 0
        });

        let current = 0;
        for (const flight of flights) {
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

            current += 1;
            await updateJob(jobId, { progress_current: current });
        }

        await updateJob(jobId, { status: 'success', finished_at: nowIso() });
    });
}

export function runFlexScanJob(jobId, flightId, window = 5) {
    enqueue(async () => {
        const flight = await getFlight(flightId);
        if (!flight) {
            await updateJob(jobId, {
                status: 'error',
                error_text: 'Flight not found',
                finished_at: nowIso()
            });
            return;
        }

        const total = window * 2 + 1;
        await updateJob(jobId, { status: 'running', started_at: nowIso(), progress_total: total, progress_current: 0 });

        const departDate = new Date(flight.departure_date);
        const returnDate = flight.return_date ? new Date(flight.return_date) : null;
        const tripLengthDays = returnDate ? Math.round((returnDate - departDate) / (1000 * 60 * 60 * 24)) : null;

        let progress = 0;
        const results = [];

        for (let delta = -window; delta <= window; delta += 1) {
            const shiftedDepart = new Date(departDate);
            shiftedDepart.setDate(shiftedDepart.getDate() + delta);

            const shiftedReturn = tripLengthDays !== null
                ? new Date(shiftedDepart.getTime() + tripLengthDays * 24 * 60 * 60 * 1000)
                : null;

            const shiftedFlight = {
                ...flight,
                departure_date: shiftedDepart.toISOString().slice(0, 10),
                return_date: shiftedReturn ? shiftedReturn.toISOString().slice(0, 10) : null
            };

            try {
                const quote = await getPriceQuote(shiftedFlight);
                await upsertFlexPrice({
                    flight_id: flight.id,
                    departure_date: shiftedFlight.departure_date,
                    return_date: shiftedFlight.return_date,
                    cabin_class: flight.cabin_class,
                    passengers: flight.passengers || 1,
                    price: quote.price,
                    currency: quote.currency || 'USD',
                    airline: quote.airline || null,
                    source: quote.source || 'unknown'
                });

                results.push({
                    departure_date: shiftedFlight.departure_date,
                    return_date: shiftedFlight.return_date,
                    price: quote.price,
                    airline: quote.airline || null,
                    source: quote.source || 'unknown'
                });
            } catch (error) {
                await upsertFlexPrice({
                    flight_id: flight.id,
                    departure_date: shiftedFlight.departure_date,
                    return_date: shiftedFlight.return_date,
                    cabin_class: flight.cabin_class,
                    passengers: flight.passengers || 1,
                    price: null,
                    currency: 'USD',
                    airline: null,
                    source: 'error'
                });

                results.push({
                    departure_date: shiftedFlight.departure_date,
                    return_date: shiftedFlight.return_date,
                    price: null,
                    error: error?.message || String(error)
                });
            }

            progress += 1;
            await updateJob(jobId, { progress_current: progress });
        }

        await updateJob(jobId, {
            status: 'success',
            result_json: JSON.stringify({ window, results }),
            finished_at: nowIso()
        });
    });
}

export function runContextRefreshJob(jobId, flightId) {
    enqueue(async () => {
        const flight = await getFlight(flightId);
        if (!flight) {
            await updateJob(jobId, {
                status: 'error',
                error_text: 'Flight not found',
                finished_at: nowIso()
            });
            return;
        }

        await updateJob(jobId, { status: 'running', started_at: nowIso(), progress_total: 1, progress_current: 0 });

        try {
            const context = await fetchTravelContext(flight);
            await upsertContext({
                flight_id: flight.id,
                context_json: JSON.stringify(context),
                expires_at: context.expires_at || null
            });

            await updateJob(jobId, {
                status: 'success',
                progress_current: 1,
                result_json: JSON.stringify(context),
                finished_at: nowIso()
            });
        } catch (error) {
            await updateJob(jobId, {
                status: 'error',
                error_text: error?.message || String(error),
                finished_at: nowIso()
            });
        }
    });
}

export async function createAndRunJob({ type, flightId = null, progressTotal = 0, window = 5, payload = null }) {
    const payloadJson = payload ? JSON.stringify(payload) : null;
    const jobId = await createJob({ type, flight_id: flightId, progress_total: progressTotal, payload_json: payloadJson });

    const localAgentEnabled = ['1', 'true', 'yes'].includes(String(process.env.LOCAL_AGENT_ENABLED || '').toLowerCase());
    if (localAgentEnabled) {
        return jobId;
    }

    if (type === 'check_now') runCheckNowJob(jobId, flightId);
    if (type === 'check_all') runCheckAllJob(jobId);
    if (type === 'flex_scan') runFlexScanJob(jobId, flightId, window);
    if (type === 'context_refresh') runContextRefreshJob(jobId, flightId);

    return jobId;
}
