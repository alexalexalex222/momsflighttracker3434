#!/usr/bin/env node

/**
 * Test email sending with Resend
 *
 * Usage:
 *   1. Set RESEND_API_KEY in .env
 *   2. Run: node scripts/test-email.js your-email@example.com
 */

import 'dotenv/config';
import { sendPriceDropAlert } from '../src/notifications/email.js';

const testEmail = process.argv[2];

if (!testEmail) {
    console.log('Usage: node scripts/test-email.js your-email@example.com');
    process.exit(1);
}

if (!process.env.RESEND_API_KEY) {
    console.log('Missing RESEND_API_KEY in .env');
    console.log('Get one free at https://resend.com');
    process.exit(1);
}

console.log(`Sending test email to ${testEmail}...`);

try {
    const result = await sendPriceDropAlert({
        to: testEmail,
        flightName: "Mom's Spain Trip",
        route: "Atlanta (ATL) → Madrid (MAD)",
        currentPrice: 656,
        previousPrice: 760,
        lowestPrice: 656,
        airline: "JetBlue"
    });

    console.log('Email sent successfully!');
    console.log('Result:', result);
} catch (error) {
    console.error('Failed to send email:', error.message);
}
