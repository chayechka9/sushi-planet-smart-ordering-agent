import Fastify, { type FastifyServerOptions } from "fastify";

import { registerHealthRoute } from "./routes/health.js";

export function createApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  app.register(registerHealthRoute);

  return app;
}
