import { Resend } from 'resend';

let resendClient = null;

function getResendClient() {
    if (resendClient) return resendClient;

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        throw new Error('Missing RESEND_API_KEY. Set it in your Railway service Variables.');
    }

    resendClient = new Resend(apiKey);
    return resendClient;
}

export async function sendPriceDropAlert({ to, flightName, route, currentPrice, previousPrice, lowestPrice, airline, checkUrl, analysis }) {
    const percentDrop = ((previousPrice - currentPrice) / previousPrice * 100).toFixed(1);

    // Build insights section if analysis provided
    let insightsHtml = '';
    if (analysis && analysis.insights && analysis.insights.length > 0) {
        const topInsights = analysis.insights.slice(0, 3);
        insightsHtml = `
            <div style="margin-top: 20px; padding: 16px; background: #fefce8; border-radius: 8px; border-left: 4px solid #eab308;">
                <p style="margin: 0 0 12px 0; font-weight: 600; color: #854d0e; font-size: 14px;">🧠 Price Intelligence</p>
                ${analysis.action ? `<p style="margin: 0 0 8px 0; font-weight: 600; color: #1e293b;">${analysis.action}: ${analysis.recommendation || ''}</p>` : ''}
                ${topInsights.map(i => `<p style="margin: 4px 0; font-size: 13px; color: #64748b;">• ${i.text?.substring(0, 120) || ''}</p>`).join('')}
            </div>
        `;
    }

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; padding: 20px; }
            .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #eab308, #ca8a04); color: #1c1917; padding: 24px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 24px; }
            .price-box { background: #f0fdf4; border: 2px solid #22c55e; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0; }
            .current-price { font-size: 36px; font-weight: bold; color: #22c55e; }
            .price-drop { font-size: 14px; color: #16a34a; margin-top: 4px; }
            .details { color: #64748b; font-size: 14px; }
            .details p { margin: 8px 0; }
            .cta { display: block; background: #eab308; color: #1c1917; text-decoration: none; padding: 14px 24px; border-radius: 8px; text-align: center; font-weight: 600; margin-top: 20px; }
            .footer { text-align: center; padding: 16px; color: #94a3b8; font-size: 12px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>✈️ Price Alert</h1>
            </div>
            <div class="content">
                <h2 style="margin-top: 0;">${flightName}</h2>
                <p style="color: #64748b; margin-top: 4px;">${route}</p>

                <div class="price-box">
                    <div class="current-price">$${currentPrice}</div>
                    <div class="price-drop">${percentDrop > 0 ? `↓ ${percentDrop}% from $${previousPrice}` : `Current price`}</div>
                </div>

                <div class="details">
                    <p><strong>Airline:</strong> ${airline || 'Various'}</p>
                    <p><strong>All-time lowest:</strong> $${lowestPrice}</p>
                    ${currentPrice <= lowestPrice ? '<p style="color: #22c55e; font-weight: bold;">✨ This is the lowest price we\'ve seen!</p>' : ''}
                </div>

                ${insightsHtml}

                <a href="https://www.google.com/travel/flights" class="cta">
                    Book Now on Google Flights
                </a>
            </div>
            <div class="footer">
                Altitude Flight Tracker — Made with love for Mom 💛
            </div>
        </div>
    </body>
    </html>
    `;

    try {
        const resend = getResendClient();
        const result = await resend.emails.send({
            from: 'Flight Tracker <onboarding@resend.dev>',
            to: to,
            subject: `Price Drop! ${flightName} now $${currentPrice} (↓${percentDrop}%)`,
            html: html
        });
        console.log('Email sent:', result);
        return result;
    } catch (error) {
        console.error('Email error:', error);
        throw error;
    }
}

export async function sendWeeklySummary({ to, flights }) {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #3b82f6, #1d4ed8); color: white; padding: 24px; text-align: center; }
            .content { padding: 24px; }
            .flight { border-bottom: 1px solid #e2e8f0; padding: 16px 0; }
            .flight:last-child { border-bottom: none; }
            .flight-name { font-weight: 600; font-size: 16px; }
            .flight-route { color: #64748b; font-size: 14px; }
            .flight-price { font-size: 24px; font-weight: bold; color: #3b82f6; }
            .price-trend { font-size: 12px; color: #64748b; }
            .footer { text-align: center; padding: 16px; color: #94a3b8; font-size: 12px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Weekly Flight Summary</h1>
            </div>
            <div class="content">
                ${flights.map(f => `
                    <div class="flight">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <div class="flight-name">${f.name}</div>
                                <div class="flight-route">${f.route}</div>
                            </div>
                            <div style="text-align: right;">
                                <div class="flight-price">$${f.currentPrice}</div>
                                <div class="price-trend">${f.trend}</div>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="footer">
                Flight Tracker - Made with love for you
            </div>
        </div>
    </body>
    </html>
    `;

    try {
        const resend = getResendClient();
        const result = await resend.emails.send({
            from: 'Flight Tracker <onboarding@resend.dev>',
            to: to,
            subject: 'Your Weekly Flight Price Summary',
            html: html
        });
        return result;
    } catch (error) {
        console.error('Email error:', error);
        throw error;
    }
}
