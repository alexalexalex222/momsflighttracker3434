-- Flight Tracker Database Schema

-- Flights to track
CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                    -- "Mom's Spain Trip"
    origin TEXT NOT NULL,                  -- "ATL"
    destination TEXT NOT NULL,             -- "MAD"
    departure_date TEXT NOT NULL,          -- "2025-09-15"
    return_date TEXT,                      -- "2025-09-25" (optional for one-way)
    passengers INTEGER DEFAULT 1,
    cabin_class TEXT DEFAULT 'economy',    -- economy, premium_economy, business, first
    preferred_airline TEXT DEFAULT 'any',  -- 'any', 'Delta', 'United', etc (used by scraper)
    is_active INTEGER DEFAULT 1,
    notify_email TEXT,                     -- Email for price alerts
    price_threshold REAL,                  -- Alert if price drops below this
    last_checked_at TEXT,                  -- Last time we checked this flight
    last_check_status TEXT,                -- ok|error|running
    last_check_error TEXT,                 -- last error string (if any)
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Price history
CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL,
    price REAL NOT NULL,
    currency TEXT DEFAULT 'USD',
    airline TEXT,                          -- "Delta", "United", etc.
    stops INTEGER,                         -- 0 = direct, 1 = 1 stop, etc.
    duration_minutes INTEGER,
    departure_time TEXT,                   -- "08:30"
    arrival_time TEXT,                     -- "22:45"
    source TEXT DEFAULT 'google_flights',
    raw_data TEXT,                         -- JSON blob of full result
    checked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (flight_id) REFERENCES flights(id)
);

-- Notifications sent
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL,
    price_id INTEGER NOT NULL,
    type TEXT NOT NULL,                    -- 'price_drop', 'price_spike', 'best_time_to_buy'
    message TEXT,
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (flight_id) REFERENCES flights(id),
    FOREIGN KEY (price_id) REFERENCES prices(id)
);

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_prices_flight_id ON prices(flight_id);
CREATE INDEX IF NOT EXISTS idx_prices_checked_at ON prices(checked_at);
CREATE INDEX IF NOT EXISTS idx_flights_active ON flights(is_active);

-- Background jobs (async checks, flex scans, context refresh)
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,                 -- check_now | check_all | flex_scan | context_refresh | send_email
    flight_id INTEGER,
    status TEXT NOT NULL DEFAULT 'queued',
    progress_current INTEGER DEFAULT 0,
    progress_total INTEGER DEFAULT 0,
    payload_json TEXT,
    result_json TEXT,
    error_text TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT,
    FOREIGN KEY (flight_id) REFERENCES flights(id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_flight_id ON jobs(flight_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- Flex-date scan results (cached)
CREATE TABLE IF NOT EXISTS flex_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL,
    departure_date TEXT NOT NULL,
    return_date TEXT DEFAULT '',
    cabin_class TEXT NOT NULL,
    passengers INTEGER NOT NULL,
    price REAL,
    currency TEXT DEFAULT 'USD',
    airline TEXT,
    source TEXT DEFAULT 'amadeus',
    checked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(flight_id, departure_date, return_date, cabin_class, passengers),
    FOREIGN KEY (flight_id) REFERENCES flights(id)
);

CREATE INDEX IF NOT EXISTS idx_flex_flight_id ON flex_prices(flight_id);
CREATE INDEX IF NOT EXISTS idx_flex_checked_at ON flex_prices(checked_at);

-- Cached travel context (news/holiday)
CREATE TABLE IF NOT EXISTS contexts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL,
    context_json TEXT NOT NULL,
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,
    FOREIGN KEY (flight_id) REFERENCES flights(id)
);

CREATE INDEX IF NOT EXISTS idx_contexts_flight_id ON contexts(flight_id);
CREATE INDEX IF NOT EXISTS idx_contexts_expires_at ON contexts(expires_at);
