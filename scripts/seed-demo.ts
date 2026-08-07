/**
 * Cellexia Subscriptions — local/dev demo seed.
 *
 * Idempotently creates:
 *   - the Shop row for --shop (or reuses the installed shop),
 *   - a demo SellingPlanConfig (frequencies 6/8/10/12 weeks, schema defaults),
 *   - three GiftRules (cycle-2 surprise, order-6 milestone, 365-day anniversary)
 *     with placeholder variant GIDs clearly marked REPLACE_ME.
 *
 * Gift rules are seeded INACTIVE on purpose: the gift engine must never try to
 * add a REPLACE_ME variant to a real cycle. Replace the GIDs, then activate.
 *
 * Usage:
 *   npx tsx scripts/seed-demo.ts --shop my-store.myshopify.com
 */
import { parseArgs } from "node:util";
import { loadDotEnv } from "./lib/env";

loadDotEnv();

const USAGE = `Usage:
  npx tsx scripts/seed-demo.ts [--shop <domain.myshopify.com>]

Options:
  --shop   Shop domain to seed. Defaults to the single installed shop.`;

const REPLACE_ME_PRODUCT = "gid://shopify/Product/REPLACE_ME";
const REPLACE_ME_VARIANT = "gid://shopify/ProductVariant/REPLACE_ME";

const DEMO_PLAN_NAME = "Cellexia Subscribe & Save (demo)";

const DEMO_GIFT_RULES: Array<{
  name: string;
  trigger: "ORDER_INDEX" | "DAYS_SUBSCRIBED";
  orderIndex?: number;
  daysSubscribed?: number;
  announceInAdvance: boolean;
}> = [
  {
    // Unannounced delight on the first renewal cycle.
    name: "Cycle 2 surprise gift (demo)",
    trigger: "ORDER_INDEX",
    orderIndex: 2,
    announceInAdvance: false,
  },
  {
    // Announced in advance: "stay subscribed and get X on order 6".
    name: "Order 6 milestone gift (demo)",
    trigger: "ORDER_INDEX",
    orderIndex: 6,
    announceInAdvance: true,
  },
  {
    name: "1-year anniversary gift (demo)",
    trigger: "DAYS_SUBSCRIBED",
    daysSubscribed: 365,
    announceInAdvance: true,
  },
];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  let shopArg: string | undefined;
  try {
    shopArg = parseArgs({ options: { shop: { type: "string" } } }).values.shop;
  } catch (err) {
    console.error(errorMessage(err));
    console.error(USAGE);
    process.exit(2);
  }

  const { default: prisma } = await import("../app/db.server");
  const { logEvent } = await import("../app/lib/events/log.server");
  const { getPrimaryShop } = await import("../app/lib/shop/install.server");

  try {
    let domain = shopArg;
    if (!domain) {
      const primary = await getPrimaryShop();
      domain = primary?.domain;
    }
    if (!domain) {
      console.error(
        "No shop domain. Pass --shop my-store.myshopify.com (or install the app first).",
      );
      console.error(USAGE);
      process.exit(2);
    }

    // 1. Shop row (schema defaults: GBP, Europe/London). A real install via
    //    `npm run dev` later syncs actual currency/timezone/locales.
    const shop = await prisma.shop.upsert({
      where: { domain },
      create: { domain, name: "Cellexia (demo seed)" },
      update: { uninstalledAt: null },
    });
    console.log(`[seed] shop ${domain} → ${shop.id}`);

    // 2. Demo selling plan config. Never overwrites an existing one so local
    //    edits survive re-runs. Non-specified fields use schema defaults
    //    (20% first order, 10% ongoing, badge "Most popular", preselected).
    const created: string[] = [];
    let plan = await prisma.sellingPlanConfig.findFirst({
      where: { shopId: shop.id, name: DEMO_PLAN_NAME },
    });
    if (plan) {
      console.log(`[seed] selling plan config already exists (${plan.id}) — leaving as-is`);
    } else {
      plan = await prisma.sellingPlanConfig.create({
        data: {
          shopId: shop.id,
          name: DEMO_PLAN_NAME,
          productIds: [REPLACE_ME_PRODUCT],
          frequenciesWeeks: [6, 8, 10, 12],
          defaultFrequencyWeeks: 8,
          // Stays PENDING until the plans module syncs it to Shopify.
          syncStatus: "PENDING",
        },
      });
      created.push(DEMO_PLAN_NAME);
      console.log(`[seed] created selling plan config ${plan.id}`);
    }

    // 3. Gift rules — seeded inactive with REPLACE_ME variants.
    for (const rule of DEMO_GIFT_RULES) {
      const existing = await prisma.giftRule.findFirst({
        where: { shopId: shop.id, name: rule.name },
      });
      if (existing) {
        console.log(`[seed] gift rule "${rule.name}" already exists — leaving as-is`);
        continue;
      }
      const row = await prisma.giftRule.create({
        data: {
          shopId: shop.id,
          name: rule.name,
          trigger: rule.trigger,
          orderIndex: rule.orderIndex ?? null,
          daysSubscribed: rule.daysSubscribed ?? null,
          variantId: REPLACE_ME_VARIANT,
          variantTitle: "REPLACE_ME — set a real gift variant GID",
          unitCostCents: 0,
          announceInAdvance: rule.announceInAdvance,
          // Inactive until the placeholder GID is replaced.
          active: false,
        },
      });
      created.push(rule.name);
      console.log(`[seed] created gift rule "${rule.name}" (${row.id})`);
    }

    if (created.length > 0) {
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor: "seed-script",
        payload: { action: "seed_demo", domain, created },
      });
    }

    console.log(`
Next steps:
  1. Replace every REPLACE_ME GID (npx prisma studio → SellingPlanConfig.productIds,
     GiftRule.variantId) with real Product / ProductVariant GIDs, and set each
     gift rule's unitCostCents (COGS feeds the LTGP math).
  2. Activate the gift rules once their variant GIDs are real (active = true).
  3. Run the app (npm run dev), open the embedded admin and sync the selling
     plan group to Shopify from the Plans page (syncStatus PENDING → SYNCED).
  4. Try a dry-run import:
       npx tsx scripts/import-subscribers.ts --file docs/sample-import.csv --dry-run
  5. Verify the app is healthy:
       npx tsx scripts/healthcheck.ts`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`[seed] fatal: ${errorMessage(err)}`);
  process.exit(1);
});
