import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { createCustomerFxExchange } from "../controllers/customer-fx.controller";

const router = Router();
router.post("/exchange",authenticate,authorize("CUSTOMER"),createCustomerFxExchange);
export default router;
