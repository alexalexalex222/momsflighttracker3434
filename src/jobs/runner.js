import { createJob, updateJob } from '../db/jobs.js';
import { getActiveFlights, getFlight, savePrice, updateFlightCheckStatus } from '../db/flights.js';
import { upsertFlexPrice } from '../db/flex.js';
import { upsertContext } from '../db/contexts.js';
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
    updateJob(jobId, { status: 'running', started_at: nowIso() });
    updateFlightCheckStatus(flight.id, 'running', null);

    try {
        const quote = await getPriceQuote(flight);
        savePrice({
            flight_id: flight.id,
            price: quote.price,
            currency: quote.currency || 'USD',
            airline: quote.airline || null,
            raw_data: quote.raw_data || null,
            source: quote.source || null
        });

        updateFlightCheckStatus(flight.id, 'ok', null);
        updateJob(jobId, {
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
        updateFlightCheckStatus(flight.id, 'error', message);
        updateJob(jobId, {
            status: 'error',
            error_text: message,
            finished_at: nowIso()
        });
    }
}

export function runCheckNowJob(jobId, flightId) {
    enqueue(async () => {
        const flight = getFlight(flightId);
        if (!flight) {
            updateJob(jobId, {
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
        const flights = getActiveFlights();
        updateJob(jobId, {
            status: 'running',
            started_at: nowIso(),
            progress_total: flights.length,
            progress_current: 0
        });

        let current = 0;
        for (const flight of flights) {
            try {
                const quote = await getPriceQuote(flight);
                savePrice({
                    flight_id: flight.id,
                    price: quote.price,
                    currency: quote.currency || 'USD',
                    airline: quote.airline || null,
                    raw_data: quote.raw_data || null,
                    source: quote.source || null
                });
                updateFlightCheckStatus(flight.id, 'ok', null);
            } catch (error) {
                const message = error?.message || String(error);
                updateFlightCheckStatus(flight.id, 'error', message);
            }

            current += 1;
            updateJob(jobId, { progress_current: current });
        }

        updateJob(jobId, { status: 'success', finished_at: nowIso() });
    });
}

export function runFlexScanJob(jobId, flightId, window = 5) {
    enqueue(async () => {
        const flight = getFlight(flightId);
        if (!flight) {
            updateJob(jobId, {
                status: 'error',
                error_text: 'Flight not found',
                finished_at: nowIso()
            });
            return;
        }

        const total = window * 2 + 1;
        updateJob(jobId, { status: 'running', started_at: nowIso(), progress_total: total, progress_current: 0 });

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
                upsertFlexPrice({
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
                upsertFlexPrice({
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
            updateJob(jobId, { progress_current: progress });
        }

        updateJob(jobId, {
            status: 'success',
            result_json: JSON.stringify({ window, results }),
            finished_at: nowIso()
        });
    });
}

export function runContextRefreshJob(jobId, flightId) {
    enqueue(async () => {
        const flight = getFlight(flightId);
        if (!flight) {
            updateJob(jobId, {
                status: 'error',
                error_text: 'Flight not found',
                finished_at: nowIso()
            });
            return;
        }

        updateJob(jobId, { status: 'running', started_at: nowIso(), progress_total: 1, progress_current: 0 });

        try {
            const context = await fetchTravelContext(flight);
            upsertContext({
                flight_id: flight.id,
                context_json: JSON.stringify(context),
                expires_at: context.expires_at || null
            });

            updateJob(jobId, {
                status: 'success',
                progress_current: 1,
                result_json: JSON.stringify(context),
                finished_at: nowIso()
            });
        } catch (error) {
            updateJob(jobId, {
                status: 'error',
                error_text: error?.message || String(error),
                finished_at: nowIso()
            });
        }
    });
}

export function createAndRunJob({ type, flightId = null, progressTotal = 0, window = 5 }) {
    const jobId = createJob({ type, flight_id: flightId, progress_total: progressTotal });

    if (type === 'check_now') runCheckNowJob(jobId, flightId);
    if (type === 'check_all') runCheckAllJob(jobId);
    if (type === 'flex_scan') runFlexScanJob(jobId, flightId, window);
    if (type === 'context_refresh') runContextRefreshJob(jobId, flightId);

    return jobId;
}
