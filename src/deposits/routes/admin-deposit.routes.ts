import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import {
  adminListDeposits, adminDepositDetail, adminReconcileDeposit, adminReverseDeposit,
} from "../controllers/admin-deposit.controller";

const router = Router();
router.get("/", authenticate, authorize("ADMIN"), adminListDeposits);
router.get("/:depositId", authenticate, authorize("ADMIN"), adminDepositDetail);
router.post("/:depositId/reconcile", authenticate, authorize("ADMIN"), adminReconcileDeposit);
router.post("/:depositId/reverse", authenticate, authorize("ADMIN"), adminReverseDeposit);
export default router;
