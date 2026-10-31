import cron from 'node-cron';
import { draftDueRenewals, runBilling } from './services/billing';
import { sendPaymentReminders } from './services/reminders';
import { isBillingRunning, setBillingRunning } from './routes/billing';

// Nightly jobs: draft renewals at 01:00, bill due subscriptions at 02:00,
// send payment reminders and suspend long-overdue accounts at 09:00.
export function startScheduler() {
  cron.schedule('0 1 * * *', async () => {
    try {
      const r = await draftDueRenewals();
      console.log(`[renewals] ${r.drafted} drafted`);
    } catch (err) {
      console.error('[renewals] failed', err);
    }
  });

  cron.schedule('0 2 * * *', async () => {
    if (isBillingRunning()) return;
    setBillingRunning(true);
    try {
      const r = await runBilling({ dryRun: false, triggeredBy: 'Scheduler' });
      console.log(`[billing] ${r.invoiceCount} invoices created`);
    } catch (err) {
      console.error('[billing] scheduled run failed', err);
    } finally {
      setBillingRunning(false);
    }
  });

  cron.schedule('0 9 * * *', async () => {
    try {
      const r = await sendPaymentReminders();
      console.log(`[reminders] ${r.sent} sent`);
    } catch (err) {
      console.error('[reminders] failed', err);
    }
  });
}
