import cronParser from 'cron-parser';

export function getScheduleInfo() {
    const cron = process.env.CRON_SCHEDULE || '0 */6 * * *';
    const timezone = process.env.CRON_TZ || 'America/New_York';

    let nextRunAt = null;
    try {
        const interval = cronParser.parseExpression(cron, {
            currentDate: new Date(),
            tz: timezone
        });
        nextRunAt = interval.next().toISOString();
    } catch (e) {
        nextRunAt = null;
    }

    return {
        cron,
        timezone,
        serverTime: new Date().toISOString(),
        nextRunAt
    };
}
