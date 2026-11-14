import "../setup";
import request from "supertest";
import { describe, expect, it } from "vitest";
import app from "../../app";
import { env } from "../../config/env";

describe("CORS", () => {
  it("should allow a configured origin", async () => {
    const allowedOrigin = env.corsOrigins[0];

    if (!allowedOrigin) {
      throw new Error(
        "CORS_ORIGINS must contain at least one origin for this test",
      );
    }

    const response = await request(app)
      .get("/health")
      .set("Origin", allowedOrigin);

    expect(response.headers["access-control-allow-origin"])
      .toBe(allowedOrigin);

    expect(response.headers["access-control-allow-credentials"])
      .toBe("true");
  });

  it("should allow Idempotency-Key in preflight requests", async () => {
    const allowedOrigin = env.corsOrigins[0];

    if (!allowedOrigin) {
      throw new Error(
        "CORS_ORIGINS must contain at least one origin for this test",
      );
    }

    const response = await request(app)
      .options("/api/v1/transfers")
      .set("Origin", allowedOrigin)
      .set("Access-Control-Request-Method", "POST")
      .set(
        "Access-Control-Request-Headers",
        "authorization,content-type,idempotency-key",
      );

    expect(response.status).toBe(204);

    const allowedHeaders = response.headers["access-control-allow-headers"]
      ?.toLowerCase()
      .split(",")
      .map((header: string) => header.trim());

    expect(allowedHeaders).toContain("idempotency-key");
    expect(allowedHeaders).toContain("authorization");
  });

  it("should reject an unconfigured origin", async () => {
    const response = await request(app)
      .get("/health")
      .set("Origin", "http://not-allowed-example.com");

    expect(response.status).toBe(500);

    expect(response.headers["access-control-allow-origin"])
      .toBeUndefined();
  });
});
