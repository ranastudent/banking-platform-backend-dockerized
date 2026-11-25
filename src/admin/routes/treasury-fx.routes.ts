import {Router} from "express";
import {authenticate} from "../../middleware/authenticate";
import {authorize} from "../../middleware/authorize";
import {createTreasuryFx} from "../controllers/treasury-fx.controller";
const router=Router();
router.post("/convert",authenticate,authorize("ADMIN"),createTreasuryFx);
export default router;
