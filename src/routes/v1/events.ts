import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { NewChannelClick } from "../../db/schema/channelClicks.js";
import { allowChannelClick, MAX_CLICK_BODY_BYTES, parseChannelClick, recordChannelClick } from "../../events/channel-clicks.js";
import { getRequestLogger } from "../../request-context.js";
import { resolveClientIp } from "../../security/inquiry-abuse.js";
import { trustedOrigin } from "./admin-shared.js";

export type EventsRouterDependencies = {
  allowClick: (ip: string) => Promise<boolean>;
  recordClick: (click: NewChannelClick) => Promise<void>;
  resolveClientIp: (context: Context) => string;
};

const productionDependencies: EventsRouterDependencies = {
  allowClick: allowChannelClick,
  recordClick: recordChannelClick,
  resolveClientIp,
};

/**
 * Anonymous website events, mounted at `/v1/events`. The browser sends them with
 * `navigator.sendBeacon` and ignores the response, so failures are logged, not surfaced,
 * and nothing here ever blocks a visitor.
 */
export function createEventsRouter(dependencies: EventsRouterDependencies = productionDependencies) {
  const router = new Hono();

  router.post(
    "/channel-click",
    bodyLimit({ maxSize: MAX_CLICK_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      // Beacons from the website carry its Origin; anything else is not a site visitor.
      if (!trustedOrigin(context)) return context.body(null, 403);
      const click = parseChannelClick(await context.req.text());
      if (!click) return context.body(null, 400);
      const logger = getRequestLogger(context);
      try {
        if (!(await dependencies.allowClick(dependencies.resolveClientIp(context)))) return context.body(null, 429);
      } catch (error) {
        // Counting is best-effort: without the rate limiter, drop the event rather than store it unchecked.
        logger.warn({ err: error }, "channel click rate limiter unavailable; event dropped");
        return context.body(null, 204);
      }
      try {
        await dependencies.recordClick(click);
      } catch (error) {
        logger.error({ err: error }, "channel click could not be stored");
        return context.body(null, 503);
      }
      return context.body(null, 204);
    },
  );

  return router;
}
