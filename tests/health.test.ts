import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GET /health", () => {
  it("reports that the service is running", async () => {
    const app = createApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "sushi-planet-smart-ordering-agent",
    });
  });
});
