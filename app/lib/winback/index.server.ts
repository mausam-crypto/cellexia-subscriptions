/**
 * Win-back engine — staged re-acquisition of cancelled subscribers timed to
 * the predicted empty date (soft touch → perk → capped discount → sunset).
 *
 * cancelContract calls scheduleWinback; the jobs module runs runWinbackSweep
 * hourly; the APPLY_WINBACK magic-link route executes reactivateFromWinback.
 */

export {
  reactivateFromWinback,
  runWinbackSweep,
  scheduleWinback,
  type ReactivateFromWinbackInput,
  type ReactivateOptions,
  type WinbackSweepStats,
} from "./engine.server";
