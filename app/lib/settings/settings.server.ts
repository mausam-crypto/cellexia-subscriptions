import prisma from "~/db.server";
import {
  defaultFor,
  settingsSchemas,
  type SettingsKey,
  type SettingsValue,
} from "./registry.server";

export async function getSetting<K extends SettingsKey>(
  shopId: string,
  key: K,
): Promise<SettingsValue<K>> {
  const row = await prisma.setting.findUnique({
    where: { shopId_key: { shopId, key } },
  });
  if (!row) return defaultFor(key);
  const parsed = settingsSchemas[key].safeParse(row.value);
  return (parsed.success ? parsed.data : defaultFor(key)) as SettingsValue<K>;
}

export async function setSetting<K extends SettingsKey>(
  shopId: string,
  key: K,
  value: SettingsValue<K>,
  updatedBy?: string,
): Promise<void> {
  const validated = settingsSchemas[key].parse(value);
  await prisma.setting.upsert({
    where: { shopId_key: { shopId, key } },
    create: { shopId, key, value: validated as object, updatedBy },
    update: { value: validated as object, updatedBy },
  });
}

export async function getAllSettings(shopId: string) {
  const keys = Object.keys(settingsSchemas) as SettingsKey[];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = await getSetting(shopId, key);
  }
  return out as { [K in SettingsKey]: SettingsValue<K> };
}
