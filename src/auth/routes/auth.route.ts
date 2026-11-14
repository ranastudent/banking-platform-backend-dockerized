import { Router } from "express";

import { register } from "../controllers/auth.controller";
import { login } from "../controllers/login.controller";
import { verifyEmailController } from "../controllers/verify-email.controller";
import { refreshToken } from "../controllers/refresh-token.controller";
import { logout } from "../controllers/logout.controller";

import {
  loginSchema,
  registerSchema,
} from "../schemas/auth.schema";

import { verifyEmailSchema } from "../schemas/verifyEmail.schema";
import { refreshTokenSchema } from "../schemas/refresh-token.schema";

import { validate } from "../../middleware/validate";
import { authRateLimiter, otpRateLimiter } from "../../middleware/rateLimiter";
import { authenticate } from "../../middleware/authenticate";
import { getMe } from "../controllers/me.controller";
import {
  forgotPasswordController,
  resetPasswordController,
} from "../controllers/password-reset.controller";
import {
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../schemas/password-reset.schema";

const router = Router();

router.post(
  "/register",
  authRateLimiter,
  otpRateLimiter,
  validate({ body: registerSchema }),
  register,
);

router.post(
  "/login",
  authRateLimiter,
  validate({ body: loginSchema }),
  login,
);

router.post(
  "/forgot-password",
  authRateLimiter,
  otpRateLimiter,
  validate({ body: forgotPasswordSchema }),
  forgotPasswordController,
);

router.post(
  "/reset-password",
  authRateLimiter,
  otpRateLimiter,
  validate({ body: resetPasswordSchema }),
  resetPasswordController,
);

router.post(
  "/verify-email",
  otpRateLimiter,
  validate({ body: verifyEmailSchema }),
  verifyEmailController,
);

router.post(
  "/refresh",
  authRateLimiter,
  validate({ body: refreshTokenSchema }),
  refreshToken,
);

router.post(
  "/logout",
  authRateLimiter,
  validate({ body: refreshTokenSchema }),
  logout,
);

router.get("/me", authenticate, getMe);

export default router;