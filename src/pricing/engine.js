import Amadeus from 'amadeus';
import { getGoogleFlightQuote } from '../scraper/google-flights.js';

let amadeusClient = null;

function getAmadeusClient() {
    const clientId = process.env.AMADEUS_CLIENT_ID;
    const clientSecret = process.env.AMADEUS_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    if (amadeusClient) return amadeusClient;
    amadeusClient = new Amadeus({ clientId, clientSecret });
    return amadeusClient;
}

function mapCabinClass(cabin) {
    switch ((cabin || '').toLowerCase()) {
        case 'premium_economy':
            return 'PREMIUM_ECONOMY';
        case 'business':
            return 'BUSINESS';
        case 'first':
            return 'FIRST';
        case 'economy':
        default:
            return 'ECONOMY';
    }
}

const AIRLINE_CODE_MAP = {
    delta: 'DL',
    united: 'UA',
    american: 'AA',
    southwest: 'WN',
    alaska: 'AS',
    jetblue: 'B6',
    spirit: 'NK',
    frontier: 'F9',
    'british airways': 'BA',
    lufthansa: 'LH',
    'air france': 'AF',
    iberia: 'IB',
    turkish: 'TK',
    klm: 'KL',
    emirates: 'EK',
    qatar: 'QR',
    'virgin atlantic': 'VS',
    'air canada': 'AC'
};

function normalizeAirlineCode(value) {
    if (!value) return null;
    const v = String(value).trim();
    if (!v) return null;
    const code = v.toUpperCase();
    if (/^[A-Z0-9]{2}$/.test(code)) return code;
    const mapped = AIRLINE_CODE_MAP[v.toLowerCase()];
    return mapped || null;
}

async function getAmadeusQuote(flight) {
    const amadeus = getAmadeusClient();
    if (!amadeus) return null;

    const adults = Number.isFinite(flight.passengers) ? Math.max(1, flight.passengers) : 1;
    const travelClass = mapCabinClass(flight.cabin_class);
    const includedAirlineCodes = normalizeAirlineCode(flight.preferred_airline);

    const params = {
        originLocationCode: flight.origin,
        destinationLocationCode: flight.destination,
        departureDate: flight.departure_date,
        adults,
        travelClass,
        currencyCode: 'USD'
    };

    if (flight.return_date) {
        params.returnDate = flight.return_date;
    }

    if (includedAirlineCodes) {
        params.includedAirlineCodes = includedAirlineCodes;
    }

    const response = await amadeus.shopping.flightOffersSearch.get(params);
    const offers = response?.data || [];
    if (!offers.length) return null;

    let best = null;
    for (const offer of offers) {
        const priceValue = parseFloat(offer?.price?.grandTotal);
        if (!Number.isFinite(priceValue)) continue;
        if (!best || priceValue < best.price) {
            const airline = offer?.validatingAirlineCodes?.[0] || null;
            best = {
                price: priceValue,
                currency: offer?.price?.currency || 'USD',
                airline,
                source: 'amadeus',
                raw_data: offer
            };
        }
    }

    return best;
}

export async function getPriceQuote(flight, { browser } = {}) {
    const amadeusQuote = await getAmadeusQuote(flight);
    if (amadeusQuote) return amadeusQuote;
    return getGoogleFlightQuote(flight, browser);
}
