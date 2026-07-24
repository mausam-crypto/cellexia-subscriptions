/**
 * Analytics engine — public surface.
 *
 * Jobs call the run* functions on their schedules (rollup daily, cohorts
 * daily/weekly, risk + empty dates daily, alerts every scan tick); admin
 * routes read the get* query functions.
 */

export * from "./rollup.server";
export * from "./cohorts.server";
export * from "./survival.server";
export * from "./risk.server";
export * from "./forecast.server";
export * from "./queries.server";
export * from "./alerts.server";
