/**
 * The scheduled-jobs registry (ARCHITECTURE.md). Keys are the public job
 * names used in `POST /jobs/:job`; each entry delegates to the owning
 * service's run*Job export. Lives outside the route file so the route only
 * exports loader/action (Remix strips server code from those exports alone).
 */
import {
  runDunningQueueJob,
  runPreDunningJob,
} from "~/services/retention/dunning.server";
import { runChurnScanJob } from "~/services/retention/churn.server";
import { processOutboxJob } from "~/services/communications/klaviyo.server";
import {
  runAnniversariesJob,
  runMilestoneJob,
} from "~/services/treatment/milestones.server";
import { runDepletionScanJob } from "~/services/treatment/depletion.server";
import { runPreShipmentJob } from "~/services/offers/preShipment.server";
import { runReconcileJob } from "~/services/core/reconcile.server";
import {
  runForecastJob,
  runPruneJob,
} from "~/services/analytics/forecast.server";
import { runLearningJob } from "~/services/analytics/learning.server";
import { runApplyAddOnsJob } from "~/services/offers/addOnFulfillment.server";
import { runPauseResumeJob } from "~/services/core/pauseResume.server";
import { runBillingJob } from "~/services/core/billingScheduler.server";
import { expireCancellationSessionsJob } from "~/services/retention/cancellation.server";

export type JobRunner = (shop?: string) => Promise<unknown>;

export const jobRegistry: Record<string, JobRunner> = {
  "dunning-queue": (shop) => runDunningQueueJob(shop),
  "pre-dunning": (shop) => runPreDunningJob(shop),
  "churn-scan": (shop) => runChurnScanJob(shop),
  outbox: (shop) => processOutboxJob(shop),
  milestones: (shop) => runMilestoneJob(shop),
  "depletion-scan": (shop) => runDepletionScanJob(shop),
  anniversaries: (shop) => runAnniversariesJob(shop),
  "pre-shipment": (shop) => runPreShipmentJob(shop),
  forecast: (shop) => runForecastJob(shop),
  reconcile: (shop) => runReconcileJob(shop),
  prune: (shop) => runPruneJob(shop),
  // Applies pending add-on lines to upcoming deliveries [fulfillment].
  "apply-add-ons": (shop) => runApplyAddOnsJob(shop),
  // Emits PAUSE_ENDING reminders and auto-resumes overdue pauses [retention-core].
  // The heartbeat that charges due cycles — Shopify never auto-bills
  // app-owned contracts. Run every 15 minutes (hourly minimum).
  billing: (shop) => runBillingJob(shop),
  "pause-resume": (shop) => runPauseResumeJob(shop),
  // Sweeps stale IN_PROGRESS cancellation sessions to ABANDONED [retention-core].
  "expire-cancel-sessions": (shop) => expireCancellationSessionsJob(shop),
  // Weekly self-recalibration of the four learned model domains [learning].
  learning: (shop) => runLearningJob(shop),
};
