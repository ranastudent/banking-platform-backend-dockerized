import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { requireIdempotencyKey } from "../../middleware/idempotency.middleware";
import { transactionHistoryRateLimiter, transferRateLimiter } from "../../middleware/rateLimiter";
import {
  getDepositMethods, getDepositLimits, quoteDeposit, createDeposit,
  createDemoDeposit, listDeposits, getDeposit, cancelDepositRequest,
  receiveDepositWebhook, receiveBkashCallback,
} from "../controllers/deposit.controller";
import { completeMockDeposit, createMockPayout } from "../controllers/mock-simulator.controller";
import { depositQuoteSchema, createDepositSchema, demoFundingSchema, cancelDepositSchema } from "../schemas/deposit.schema";

const router = Router();

router.get("/methods", authenticate, authorize("CUSTOMER", "ADMIN"), getDepositMethods);
router.get("/limits", authenticate, authorize("CUSTOMER", "ADMIN"), getDepositLimits);
router.post("/quote", authenticate, authorize("CUSTOMER", "ADMIN"), validate({ body: depositQuoteSchema }), quoteDeposit);
router.post("/", authenticate, transferRateLimiter, authorize("CUSTOMER", "ADMIN"), requireIdempotencyKey, validate({ body: createDepositSchema }), createDeposit);
router.post("/demo", authenticate, transferRateLimiter, authorize("CUSTOMER", "ADMIN"), requireIdempotencyKey, validate({ body: demoFundingSchema }), createDemoDeposit);
router.get("/", authenticate, authorize("CUSTOMER", "ADMIN"), transactionHistoryRateLimiter, listDeposits);
router.get("/:depositId", authenticate, authorize("CUSTOMER", "ADMIN"), transactionHistoryRateLimiter, getDeposit);
router.post("/:depositId/cancel", authenticate, transferRateLimiter, authorize("CUSTOMER", "ADMIN"), validate({ body: cancelDepositSchema }), cancelDepositRequest);

// Provider callbacks authenticate using provider-specific secret/signature logic,
// not customer JWT. Provider adapter registration must be completed per provider.
router.post("/webhooks/:provider", receiveDepositWebhook);
// bKash Tokenized Checkout redirects the payer to a GET callback URL.
router.get("/bkash/callback", receiveBkashCallback);

// Non-production-only, authenticated virtual provider simulator endpoints.
router.post("/simulator/:provider/:depositId/complete", authenticate, authorize("CUSTOMER", "ADMIN"), completeMockDeposit);
router.post("/simulator/payout/:accountId", authenticate, authorize("CUSTOMER", "ADMIN"), requireIdempotencyKey, createMockPayout);

export default router;
