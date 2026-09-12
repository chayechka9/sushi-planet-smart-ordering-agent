import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationAgentResponse,
} from "../src/application/local-conversation-agent.js";
import {
  createOpenAIConversationRuntime,
  type OpenAIConversationRuntimeDependencies,
} from "../src/composition/openai-conversation-runtime.js";
import { OpenAIRuntimeConfigurationError } from "../src/config/openai.js";
import { createApp } from "../src/app.js";
import type {
  OpenAIResponsesFetch,
} from "../src/integrations/openai/responses-http-transport.js";

const syntheticApiKey = "synthetic-runtime-key-never-send";

const deterministicResponse: ConversationAgentResponse = {
  kind: "menu",
  menu: [],
  order: {
    orderId: "synthetic-order",
    status: "draft",
    items: [],
    fulfilment: null,
    customer: {},
    missingFields: ["cart", "fulfilment", "first_name", "phone"],
    totals: {
      subtotalCents: 0,
      fulfilmentCents: 0,
      totalCents: 0,
      currency: "EUR",
    },
    totalIsFinal: false,
    backendStatus: {
      payment: "not_requested",
      orderSubmission: "not_started",
    },
  },
};

function createDependencies(): {
  dependencies: OpenAIConversationRuntimeDependencies;
  conversationAgent: { handle: ReturnType<typeof vi.fn> };
} {
  const conversationAgent = {
    handle: vi.fn(async () => deterministicResponse),
  };
  return {
    dependencies: {
      conversationAgent,
      stateStore: {
        findByConversationId: vi.fn(() => undefined),
      },
    },
    conversationAgent,
  };
}

function strictShowMenuResponse(): Response {
  return {
    ok: true,
    async json() {
      return {
        output_text: JSON.stringify({
          kind: "command",
          command: {
            type: "show_menu",
            menuItemId: null,
            quantity: null,
            firstName: null,
            lastName: null,
            phone: null,
            address: null,
          },
          reason: null,
        }),
      };
    },
  } as Response;
}

function input() {
  return {
    channel: "synthetic-channel",
    userId: "synthetic-user",
    conversationId: "synthetic-conversation",
    messageId: "synthetic-message",
    text: "покажи меню",
  };
}

describe("OpenAI conversation runtime composition", () => {
  let globalFetch: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("real global fetch is forbidden"));
  });

  afterEach(() => {
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it("is disabled by default", () => {
    const { dependencies } = createDependencies();

    expect(
      createOpenAIConversationRuntime(dependencies, { environment: {} }),
    ).toEqual({ enabled: false });
  });

  it("does not require a key or call fetch when explicitly disabled", () => {
    const { dependencies, conversationAgent } = createDependencies();
    const fetcher = vi.fn<OpenAIResponsesFetch>();

    const runtime = createOpenAIConversationRuntime(dependencies, {
      environment: { OPENAI_RUNTIME_ENABLED: "false" },
      fetcher,
    });

    expect(runtime).toEqual({ enabled: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(conversationAgent.handle).not.toHaveBeenCalled();
  });

  it("does not enable runtime when only an API key is present", () => {
    const { dependencies } = createDependencies();
    const fetcher = vi.fn<OpenAIResponsesFetch>();

    const runtime = createOpenAIConversationRuntime(dependencies, {
      environment: { OPENAI_API_KEY: syntheticApiKey },
      fetcher,
    });

    expect(runtime).toEqual({ enabled: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects enabled runtime without a key using a safe configuration error", () => {
    const { dependencies } = createDependencies();
    const fetcher = vi.fn<OpenAIResponsesFetch>();

    let caught: unknown;
    try {
      createOpenAIConversationRuntime(dependencies, {
        environment: { OPENAI_RUNTIME_ENABLED: "true" },
        fetcher,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenAIRuntimeConfigurationError);
    expect(caught).toMatchObject({ code: "invalid_configuration" });
    expect(String(caught)).not.toContain("OPENAI_API_KEY");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("composes the interpreter and injected deterministic dependencies", async () => {
    const { dependencies, conversationAgent } = createDependencies();
    const fetcher = vi
      .fn<OpenAIResponsesFetch>()
      .mockResolvedValue(strictShowMenuResponse());
    const runtime = createOpenAIConversationRuntime(dependencies, {
      environment: {
        OPENAI_RUNTIME_ENABLED: "true",
        OPENAI_API_KEY: syntheticApiKey,
      },
      fetcher,
    });

    expect(runtime.enabled).toBe(true);
    if (!runtime.enabled) throw new Error("Expected enabled runtime");

    await expect(runtime.service.handle(input())).resolves.toEqual({
      kind: "command_applied",
      command: { type: "show_menu" },
      response: deterministicResponse,
    });
    expect(conversationAgent.handle).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("uses Luna, high reasoning and store false in the composed request", async () => {
    const { dependencies } = createDependencies();
    let requestBody: Record<string, unknown> | undefined;
    const fetcher = vi.fn<OpenAIResponsesFetch>(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return strictShowMenuResponse();
    });
    const runtime = createOpenAIConversationRuntime(dependencies, {
      environment: {
        OPENAI_RUNTIME_ENABLED: "true",
        OPENAI_API_KEY: syntheticApiKey,
      },
      fetcher,
    });
    if (!runtime.enabled) throw new Error("Expected enabled runtime");

    await runtime.service.handle(input());

    expect(requestBody).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: { effort: "high" },
      store: false,
    });
    expect(JSON.stringify(requestBody)).not.toContain(syntheticApiKey);
  });

  it("leaves the ordinary server bootstrap without OpenAI wiring", async () => {
    const serverSource = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    );
    expect(serverSource.toLowerCase()).not.toContain("openai");

    const app = createApp();
    await app.ready();
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      const absentAI = await app.inject({
        method: "POST",
        url: "/ai/conversations",
        payload: {},
      });
      expect(health.statusCode).toBe(200);
      expect(absentAI.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
