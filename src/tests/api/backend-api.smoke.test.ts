import "../setup";
import request from "supertest";
import { describe, expect, it } from "vitest";
import app from "../../app";

/**
 * Backend API smoke tests.
 *
 * These tests validate that the Express app boots, infrastructure health
 * endpoints respond, API routes are mounted, and protected endpoints reject
 * unauthenticated requests. They intentionally do not create financial data.
 *
 * Run only with the isolated .env.test database/Redis described in
 * src/tests/TEST-ENVIRONMENT.md.
 */
describe("Backend API smoke checks", () => {
  it("GET /health reports PostgreSQL and Redis connectivity", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      database: "connected",
      redis: "connected",
    });
    expect(response.body.requestId).toBeTruthy();
  });

  it("GET /ready confirms the app is ready to serve requests", async () => {
    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ready: true });
  });

  it.each([
    ["accounts", "GET", "/api/v1/accounts"],
    ["deposit methods", "GET", "/api/v1/deposits/methods"],
    ["admin test endpoint", "GET", "/api/v1/admin/test"],
    ["transfer endpoint", "POST", "/api/v1/transfers"],
  ])("%s endpoint is mounted and requires authentication", async (_name, method, path) => {
    const apiRequest = method === "POST"
      ? request(app).post(path).send({})
      : request(app).get(path);

    const response = await apiRequest;

    expect(response.status).toBe(401);
  });

  it("unknown API paths return a not-found response with a request ID", async () => {
    const response = await request(app).get("/api/v1/__smoke_test_unknown_route__");

    expect(response.status).toBe(404);
    expect(response.body.requestId).toBeTruthy();
  });
});
