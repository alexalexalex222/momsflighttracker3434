#!/bin/bash

# Install the launchd job for automatic flight checking

PLIST_NAME="com.flighttracker.scrape.plist"
PLIST_SOURCE="$HOME/flight-tracker/scripts/$PLIST_NAME"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "Installing Flight Tracker scheduler..."

# Copy plist to LaunchAgents
cp "$PLIST_SOURCE" "$PLIST_DEST"

# Unload if already loaded
launchctl unload "$PLIST_DEST" 2>/dev/null

# Load the new plist
launchctl load "$PLIST_DEST"

echo "✅ Scheduler installed!"
echo ""
echo "The scraper will run:"
echo "  - Immediately when your Mac wakes up"
echo "  - Every 4 hours while your Mac is on"
echo ""
echo "To check status:  launchctl list | grep flighttracker"
echo "To uninstall:     launchctl unload $PLIST_DEST && rm $PLIST_DEST"
echo "To run manually:  cd ~/flight-tracker && npm run scrape"
