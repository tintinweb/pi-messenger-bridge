import type { TransportStatus } from "../types.js";

const TRANSPORT_ABBREV: Record<string, string> = {
  telegram: "tg",
  whatsapp: "wa",
  slack: "slk",
  discord: "dc",
};

/**
 * Status widget showing remote pilot connection status
 */
export function createStatusWidget(
  transports: TransportStatus[],
  usersByTransport: Record<string, string[]>
): string | undefined {
  if (transports.length === 0) {
    return undefined;
  }

  const transportList = transports
    .map((t) => {
      const abbrev = TRANSPORT_ABBREV[t.type] || t.type.slice(0, 3);
      const userCount = usersByTransport[t.type]?.length || 0;
      const userSuffix = userCount > 0 ? `:${userCount}` : "";
      return `[${abbrev}${userSuffix}]`;
    })
    .join("");

  return `💬 ${transportList}`;
}
