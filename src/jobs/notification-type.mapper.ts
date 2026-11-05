import { NotificationType as PrismaNotificationType } from "@prisma/client";
import type { NotificationType as NotificationEventType } from "./types";

/**
 * Application event types are intentionally more specific than the
 * persisted Prisma NotificationType enum. Keep the original event type in
 * notification metadata while storing the supported database category.
 */
const notificationTypeMap: Record<
  NotificationEventType,
  PrismaNotificationType
> = {
  TRANSFER_SUCCESS: PrismaNotificationType.TRANSACTION,
  TRANSFER_FAILED: PrismaNotificationType.TRANSACTION,
  DEPOSIT_SUCCESS: PrismaNotificationType.TRANSACTION,
  WITHDRAWAL_SUCCESS: PrismaNotificationType.TRANSACTION,
  ACCOUNT_BLOCKED: PrismaNotificationType.SECURITY,
  SECURITY_ALERT: PrismaNotificationType.SECURITY,
};

export const toPrismaNotificationType = (
  notificationType: NotificationEventType,
): PrismaNotificationType => notificationTypeMap[notificationType];
