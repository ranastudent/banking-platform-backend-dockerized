import { describe, expect, it } from "vitest";
import { NotificationType as PrismaNotificationType } from "@prisma/client";
import { toPrismaNotificationType } from "../../jobs/notification-type.mapper";

describe("notification type persistence mapping", () => {
  it.each([
    ["TRANSFER_SUCCESS", PrismaNotificationType.TRANSACTION],
    ["TRANSFER_FAILED", PrismaNotificationType.TRANSACTION],
    ["DEPOSIT_SUCCESS", PrismaNotificationType.TRANSACTION],
    ["WITHDRAWAL_SUCCESS", PrismaNotificationType.TRANSACTION],
    ["ACCOUNT_BLOCKED", PrismaNotificationType.SECURITY],
    ["SECURITY_ALERT", PrismaNotificationType.SECURITY],
  ] as const)(
    "maps %s to a supported Prisma enum value",
    (eventType, dbType) => {
      expect(toPrismaNotificationType(eventType)).toBe(dbType);
    },
  );
});
