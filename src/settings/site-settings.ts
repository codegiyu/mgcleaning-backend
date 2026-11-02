import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { siteSettings, type SiteSettings } from "../db/schema/siteSettings.js";
import { env } from "../env.js";

export const SITE_SETTINGS_ID = 1;

type Selectable = Pick<ReturnType<typeof getDb>, "select">;

export async function readSiteSettings(executor: Selectable = getDb()): Promise<SiteSettings | null> {
  const [row] = await executor.select().from(siteSettings).where(eq(siteSettings.id, SITE_SETTINGS_ID)).limit(1);
  return row ?? null;
}

/**
 * Every inbox that gets inquiry alerts: the one set in Admin → Settings, if any, and always
 * the deployment's INQUIRY_NOTIFICATION_TO. An address listed twice is sent to once.
 */
export function notificationRecipients(settings: Pick<SiteSettings, "inquiryNotificationEmail"> | null, deploymentInbox = env.INQUIRY_NOTIFICATION_TO) {
  const inboxes = [settings?.inquiryNotificationEmail, deploymentInbox].filter((inbox): inbox is string => Boolean(inbox));
  return inboxes.filter((inbox, index) => inboxes.findIndex((other) => other.toLowerCase() === inbox.toLowerCase()) === index);
}
