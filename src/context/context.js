const AIRPORT_CITIES = {
    ATL: 'Atlanta',
    JFK: 'New York',
    LAX: 'Los Angeles',
    ORD: 'Chicago',
    DFW: 'Dallas',
    MAD: 'Madrid',
    BCN: 'Barcelona',
    CDG: 'Paris',
    LHR: 'London',
    FCO: 'Rome',
    AMS: 'Amsterdam',
    FRA: 'Frankfurt',
    LIS: 'Lisbon',
    MIA: 'Miami',
    SFO: 'San Francisco',
    SEA: 'Seattle',
    BOS: 'Boston',
    IAD: 'Washington',
    DCA: 'Washington',
    EWR: 'Newark',
    PHX: 'Phoenix',
    DEN: 'Denver'
};

function getNthWeekdayOfMonth(year, month, weekday, nth) {
    const firstDay = new Date(year, month, 1);
    const firstWeekday = firstDay.getDay();
    const offset = (weekday - firstWeekday + 7) % 7;
    const day = 1 + offset + (nth - 1) * 7;
    return new Date(year, month, day);
}

function getLastWeekdayOfMonth(year, month, weekday) {
    const lastDay = new Date(year, month + 1, 0);
    const lastWeekday = lastDay.getDay();
    const offset = (lastWeekday - weekday + 7) % 7;
    return new Date(year, month, lastDay.getDate() - offset);
}

function getHolidayDates(year) {
    return [
        { name: 'New Year\'s Day', date: new Date(year, 0, 1) },
        { name: 'Martin Luther King Jr. Day', date: getNthWeekdayOfMonth(year, 0, 1, 3) }, // 3rd Monday Jan
        { name: 'Presidents\' Day', date: getNthWeekdayOfMonth(year, 1, 1, 3) }, // 3rd Monday Feb
        { name: 'Memorial Day', date: getLastWeekdayOfMonth(year, 4, 1) }, // last Monday May
        { name: 'Independence Day', date: new Date(year, 6, 4) },
        { name: 'Labor Day', date: getNthWeekdayOfMonth(year, 8, 1, 1) }, // 1st Monday Sep
        { name: 'Thanksgiving', date: getNthWeekdayOfMonth(year, 10, 4, 4) }, // 4th Thursday Nov
        { name: 'Christmas', date: new Date(year, 11, 25) }
    ];
}

function cityFor(code) {
    return AIRPORT_CITIES[code] || code;
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function addHours(date, hours) {
    const d = new Date(date);
    d.setHours(d.getHours() + hours);
    return d;
}

function dateDiffDays(a, b) {
    const ms = Math.abs(a - b);
    return Math.round(ms / (1000 * 60 * 60 * 24));
}

function getHolidayNote(departureDate) {
    if (!departureDate) return null;
    const date = new Date(departureDate);
    if (Number.isNaN(date.getTime())) return null;

    const holidays = getHolidayDates(date.getFullYear());
    for (const holiday of holidays) {
        const holidayDate = holiday.date;
        if (dateDiffDays(date, holidayDate) <= 3) {
            return `Travel is within 3 days of ${holiday.name}, which can increase demand and delays.`;
        }
    }

    return null;
}

function buildQuery({ origin, destination, preferred_airline }) {
    const originCity = cityFor(origin);
    const destCity = cityFor(destination);
    const airline = preferred_airline && preferred_airline !== 'any' ? preferred_airline : '';

    const terms = [
        'airport',
        'airline',
        'flight',
        'delay',
        'disruption',
        'strike',
        'protest',
        'shutdown',
        'union',
        'holiday travel',
        'travel warning'
    ];

    let query = `("${originCity}" OR "${destCity}") AND (` + terms.join(' OR ') + ')';
    if (airline) {
        query += ` OR "${airline}"`;
    }

    return query;
}

async function fetchGdeltArticles(query) {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=8&format=json&sort=DateDesc`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`GDELT error (${response.status})`);
    }

    const data = await response.json();
    const articles = Array.isArray(data?.articles) ? data.articles : [];
    return articles.map(article => ({
        title: article?.title || article?.name || 'Headline',
        url: article?.url || article?.urlurl || article?.shareimage || '',
        source: article?.sourceCountry || article?.sourceCommonName || article?.source || 'Unknown',
        published_at: article?.seendate || article?.seenDate || null
    })).filter(a => a.url);
}

export async function fetchTravelContext(flight) {
    const query = buildQuery(flight);
    const headlines = await fetchGdeltArticles(query);
    const holidayNote = getHolidayNote(flight.departure_date);

    const context = {
        query,
        summary: 'Recent travel-related headlines for this route. Click links for details.',
        headlines: headlines.slice(0, 5),
        holidayNote,
        fetched_at: new Date().toISOString(),
        expires_at: addHours(new Date(), 6).toISOString()
    };

    return context;
}
