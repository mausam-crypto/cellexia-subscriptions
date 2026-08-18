# UPDATE — the future-update contract

How releases of Cellexia Subscriptions are versioned, what every release
guarantees, and the exact procedure to apply (or roll back) an update.

Related: [INSTALL.md](./INSTALL.md) (first install), [OPERATIONS.md](./OPERATIONS.md)
(backups, secret rotation), [CHANGELOG.md](../CHANGELOG.md).

---

## 1. Versioning

Releases are delivered as ZIPs named `cellexia-subscriptions-vMAJOR.MINOR.PATCH.zip`
and follow **semantic versioning**:

| Bump | Meaning | Examples |
|---|---|---|
| **PATCH** (1.0.x) | Bug fixes only. No schema changes, no env changes, no behavior changes you'd notice. | Fix a decline-code mapping; portal copy fix. |
| **MINOR** (1.x.0) | New features, **additive** DB migrations, new *optional* env vars or settings (with safe defaults). Nothing existing breaks. | New save-offer type; new analytics chart; new optional `SMS_PROVIDER` option. |
| **MAJOR** (x.0.0) | Anything breaking: required new env vars, destructive/renaming migrations, changed webhook topics or scopes, changed API revision. Ships with a dedicated **Migration notes** section in the CHANGELOG. | Admin API version bump requiring re-deploy + scope change. |

The version lives in `package.json` and at the top of [CHANGELOG.md](../CHANGELOG.md).

## 2. What we promise in every release

1. **`npm run verify` passes** — the mandatory release gate. It runs, in
   cheap-to-expensive order, `tsc --noEmit && vitest run && remix vite:build`.
   The production build step is not optional decoration: typecheck and the
   full test suite both passed on a tree whose production build did not
   compile (a route component referenced a `.server` module), so a release is
   only a release once all three are green. No ZIP is cut from a tree where
   `npm run verify` exits non-zero.

   Since v1.6.3 (limit model corrected in v1.6.4) the gate also covers what
   used to be discoverable only on the deploy console: theme-extension
   **size budgets** (**TOTAL** shipped Liquid ≤ 88KB against Shopify's 100KB
   hard reject — a real `shopify app deploy` verified the 100KB limit is
   enforced on the sum of every `.liquid` file in the extension, *not*
   per-file — plus a per-file belt at the same ceiling, block count, bundle
   and locale-file caps, plus our own JS/CSS performance ceilings —
   `tests/liquid/size-limits.test.ts`), block **schema validity** mirroring
   the Shopify CLI's checks (`tests/liquid/schema.test.ts`), and **app-proxy
   subpath consistency** across `shopify.app.toml`, the portal code and the
   storefront JS, including the permanent ban on the colliding legacy value
   (`tests/proxy-subpath.test.ts`). A tree that would fail
   `shopify app deploy` for any of those reasons now fails `npm run verify`
   first.
2. A **CHANGELOG entry** (Keep-a-Changelog style: Added / Changed / Fixed /
   Migration notes) — read it *before* updating.
3. **Additive migrations**: new tables/columns/indexes only, applied with
   `prisma migrate deploy`. Destructive changes only ever appear in a MAJOR
   release, flagged loudly in Migration notes.
4. **No breaking env changes without a MAJOR bump**: new env vars in MINOR
   releases always have working defaults; a var becoming required, renamed or
   re-interpreted forces a MAJOR bump and is listed in Migration notes.
5. Webhook topics / scopes / `shopify.app.toml` changes are called out
   explicitly, because they require an `npm run deploy` (and scope changes
   require re-approving the install).

## 3. Keep your own git repo (strongly recommended)

The ZIP is the delivery format, but you should track it in git from day one:

```bash
cd cellexia-subscriptions
git init && git add -A && git commit -m "v1.0.0 as delivered"
```

Benefits: applying a new ZIP becomes a reviewable diff (`git diff` after
unzipping), your local patches survive updates as merges instead of being
silently overwritten, and rollback is `git checkout`. Hotfixes we hand you may be
described as a git diff/patch — apply with `git apply hotfix.patch` — or as a
full PATCH ZIP; both are equivalent.

## 4. Update procedure

Budget ~15 minutes; renewals missed during a short deploy window are picked up by
the next scheduler tick, so there is no need to "pause billing".

1. **Read the CHANGELOG entry** for the new version, especially Migration notes.
2. **Back up the database** (see [OPERATIONS.md](./OPERATIONS.md#database-backups)):

   ```bash
   pg_dump "$DATABASE_URL" -Fc -f backup-pre-vX.Y.Z-$(date +%F).dump
   ```

3. **Unzip over the previous directory, keeping `.env`, your `fly.toml`, YOUR
   `shopify.app.toml` and YOUR `extensions/*/shopify.extension.toml`**:

   ```bash
   unzip -o cellexia-subscriptions-vX.Y.Z.zip -d cellexia-subscriptions/
   ```

   `.env`, `fly.toml` and `prisma/migrations/` from earlier versions are never
   removed by an update — migrations are cumulative. **The ZIP ships
   `shopify.app.toml` and the extension tomls as TEMPLATES** (placeholder
   `client_id` and `application_url`, no extension `uid`s): unzipping
   overwrites your linked copies, so restore them from git (§3) — or unzip to
   a scratch directory and copy everything except those files. Then apply
   the release's toml deltas by hand: every release that adds webhook
   topics, scopes or extension settings lists the exact lines in its
   CHANGELOG entry / release notes (e.g. 1.28.0: three `fulfillments/*`
   webhook subscriptions). If you keep a git repo (§3), commit now and review
   `git diff` against the previous release.
4. **Install exact dependencies**: `npm ci`
5. **Apply migrations**: `npx prisma migrate deploy`
   (safe to run before deploying code — migrations are additive, so old code
   runs happily against the new schema.)
6. **Push app config if the CHANGELOG says so** (webhooks/scopes/extension
   changed): `npm run deploy`
7. **Deploy + restart the host**: `flyctl deploy` (or your host's deploy). The
   container start re-runs `prisma migrate deploy` harmlessly.
8. **Verify**: `GET /api/health` is green; Audit page shows a fresh
   `billing_run` JobRun; place/exercise one portal action on a test contract.

## 5. Rollback

1. Redeploy the **previous ZIP** (or `git checkout` the previous release tag),
   `npm ci`, deploy to the host.
2. **Database**: because migrations are additive, the previous app version runs
   fine against the newer schema — *do not* try to reverse migrations in
   production. Leave the schema as is.
3. If you later re-apply the update, `prisma migrate deploy` continues where it
   left off. If a migration **failed halfway** and blocks deploys, inspect it,
   fix the cause, then mark it:

   ```bash
   npx prisma migrate status                       # see which migration is stuck
   npx prisma migrate resolve --rolled-back <name> # if you reverted its effects
   # or
   npx prisma migrate resolve --applied <name>     # if it actually completed
   ```

   Only use `--applied` when you have confirmed (via `psql`) the migration's DDL
   really took effect. When in doubt, restore the §4 backup instead:
   `pg_restore -d "$DATABASE_URL" --clean backup-pre-vX.Y.Z-....dump`.

## 6. Hotfixes

Urgent fixes between releases are handed over as either:

- a **patch file** (if you keep a git repo): `git apply cellexia-hotfix-<id>.patch`,
  then deploy. The next official ZIP always contains the fix, so overwriting
  later is safe; or
- a **full PATCH-version ZIP**: follow §4 (steps 2–8; usually no migrations).

Record which hotfixes you applied in your own repo's log — CHANGELOG will list
them under the next version as "(previously shipped as hotfix)".
