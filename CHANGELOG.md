# Changelog

All notable changes to Cellexia Subscriptions. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org) as contracted in [docs/UPDATE.md](docs/UPDATE.md).

## [1.1.0] — 2026-07-23

### Added

- **Buy box design studio**: new admin **Buy box designer** page for the PDP
  widget. Six design presets — `classic` (the v1.0.0 layout), `toggle`
  (segmented tabs), `tiles` (side-by-side comparison), `inline` (one-line
  checkbox upgrade), `value_stack` (benefit-list panel), `planner`
  (frequency-first chips) — each a distinct CRO archetype, with deep
  customization of the selected preset: layout (option ordering, density,
  radius/border, frequency dropdown vs chips, show/hide toggles), style
  (colors, font scale, sanitized widget-scoped custom CSS) and **per-locale
  text overrides** with `{percent}`/`{amount}`/`{frequency}` templates
  (resolution: current locale → `en` → the extension locale files). Changes
  are previewable before publishing; publishing mirrors the config to the
  shop metafield `cellexia.buybox_design`, which the theme block reads
  null-safely — changing or reverting a design never touches the theme.
- **Revision history with restore**: every save is an append-only
  `WidgetDesignRevision`; restore copies an old revision into a new one and
  publishes it, so every design change is reversible in one click. Publishes
  and restores are logged as `admin.action` audit events.
- **Design attribution analytics**: subscription add-to-carts are stamped
  with a hidden `_cx_design` line property (underscore-prefixed — hidden from
  customers in themes and checkout); the ORDERS_CREATE webhook logs
  `widget.design_attributed` events (payload `{designKey, orderId}`) and the
  designer's performance card reports subscription orders and take-rate
  share per design. New canonical event type: `widget.design_attributed`.
- Theme-editor emergency override: new `design_source` block setting
  (default **App design**) can force a preset from the theme editor if the
  app is unreachable.

### Migration notes

- **No breaking changes; with no design published the widget renders
  identically to v1.0.0.** The zero-config fallback, all existing block
  settings and the selling-plan wiring are unchanged.
- Additive migration `0002` (new `WidgetDesignRevision` table):
  `npx prisma migrate deploy`.
- The theme extension changed (new snippets/assets and the `design_source`
  block setting) — run `npm run deploy`. Existing block placement keeps
  working as-is; no theme-editor action is required.

## [1.0.0] — 2026-07-23

Initial release.

### Added

- **Launch safety & preview**: the app installs **dark** — Setup mode until the
  admin explicitly goes live. While in Setup: customer-facing jobs skip
  themselves (logged `skipped: setup_mode`), customer notifications are
  suppressed at source (only OTP codes, operator alerts and import summaries
  send), no Klaviyo events are enqueued, the public portal is closed behind a
  friendly page, and the buy box renders hidden via the
  `cellexia.launch_status` shop metafield. Admin **Preview & launch** page:
  signed storefront preview links (`?cx_preview`, 7-day TTL) reveal the buy
  box on the live theme only in the admin's own browser — PDP, cart and
  checkout previewable with zero visitor impact; portal preview sessions
  render the full customer portal (real subscriber or local-only demo
  subscription) with every mutating action intercepted. **Go live** flips the
  setting + metafield, logs the flip, and offers to stagger overdue renewals
  over 3 days so launch never triggers a burst of charges; revert-to-setup is
  the emergency kill switch.
- **Selling plans**: plan-group config + sync (first-order/ongoing discounts via
  pricing policies, optional first-order gift, prepaid modelling), per-product
  cadence intelligence (real empty dates), theme app extension buy box
  (preselect, badge, savings formats).
- **Billing**: timezone-safe renewal scheduler with `JobLock` leases, crash-proof
  idempotent billing attempts, prepaid handling, stale-attempt sweep; internal
  60s tick or external-cron mode (`POST /api/jobs/run`).
- **Dunning**: decline taxonomy (SOFT/HARD/AUTH_REQUIRED), payday-aligned retry
  ladder, backup payment fallback, 3DS challenge magic links, card pre-expiry
  notices, recovery/exhaustion handling (default exhausted action: pause).
- **Customer portal** on the store domain (app proxy): OTP login, skip/unskip,
  delay, frequency change, swap, quantity, add/remove lines, one-time add-ons,
  pause/resume with auto-resume, address & card updates, contextual prompts.
- **Magic links**: signed, hashed-at-rest, single-use action tokens (skip,
  delay, add-to-next, update card, resume, pause, swap, 3DS confirm, login).
- **Cancel-save flow**: reason survey, reason-matched saves, capped final offer
  with cooldown, full `CancelSession` recording, 90-day retention tracking;
  FTC click-to-cancel compliant (≤3 steps).
- **Gifts & lifecycle**: gift rules by order index / days subscribed / save flow
  / win-back; surprise cycle-2 gift, announced milestone (cycle 6), rewards
  unlock (day 90), anniversary (day 365); gift COGS in profit math.
- **Win-back**: staged touches (soft → perk → capped discount → sunset) timed to
  predicted empty date.
- **Klaviyo**: outbox-backed event delivery with retries, profile sync, event
  mapping; SMTP fallback + notification log.
- **Analytics**: daily rollups, cohort survival + cumulative LTGP, churn risk
  scores, predicted empty dates, take rate, dunning recovery.
- **Admin (Polaris)**: dashboard, analytics, subscribers + timelines, dunning,
  alerts, audit, bulk ops (stockout actions, price change batches with notice),
  plans, gifts, cancel-flow config, settings registry, import.
- **Webhooks**: full topic coverage with `X-Shopify-Webhook-Id` dedupe and
  failure visibility; GDPR topics handled.
- **Import**: CSV importer (`subscriptionContractAtomicCreate`) with dry-run,
  batch tracking and re-run safety; sample file + platform mappings
  ([docs/MIGRATION.md](docs/MIGRATION.md)).
- **Ops**: `/api/health`, alerting with operator emails, i18n framework
  (English master catalog), Dockerfile, complete documentation set.

### Migration notes

- Fresh install only — see [docs/INSTALL.md](docs/INSTALL.md). Subscriber
  migration from Recharge/Skio/Appstle/Bold: [docs/MIGRATION.md](docs/MIGRATION.md).
