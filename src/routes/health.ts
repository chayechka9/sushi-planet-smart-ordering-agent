import type { FastifyPluginAsync } from "fastify";

const healthResponse = {
  status: "ok",
  service: "sushi-planet-smart-ordering-agent",
} as const;

export const registerHealthRoute: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => healthResponse);
};
