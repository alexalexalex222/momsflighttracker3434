#!/bin/bash

# Flight Tracker - Automated Scrape Script
# This runs Claude with chrome automation to check flight prices

cd ~/flight-tracker

# Log file for debugging
LOG_FILE="data/scrape.log"
echo "========================================" >> "$LOG_FILE"
echo "Scrape started at $(date)" >> "$LOG_FILE"

# Check if Claude is available
if ! command -v claude &> /dev/null; then
    echo "Error: Claude CLI not found" >> "$LOG_FILE"
    exit 1
fi

# Run Claude with the scrape prompt
claude --chrome -p "$(cat src/agent/scrape-prompt.md)" --dangerously-skip-permissions 2>&1 | tee -a "$LOG_FILE"

echo "Scrape completed at $(date)" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
