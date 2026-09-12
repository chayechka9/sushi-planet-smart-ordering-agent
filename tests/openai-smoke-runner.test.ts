import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalConversationCheckoutFlow } from "../src/application/local-conversation-agent.js";
import type { OpenAIResponsesFetch } from "../src/integrations/openai/responses-http-transport.js";
import { runOpenAISmoke } from "../src/scripts/openai-smoke-runner.js";

const syntheticApiKey = "synthetic-smoke-secret-never-send";
const enabledEnvironment = {
  OPENAI_RUNTIME_ENABLED: "true",
  OPENAI_API_KEY: syntheticApiKey,
};

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

describe("controlled OpenAI smoke runner", () => {
  let globalFetch: ReturnType<typeof vi.spyOn>;
  let temporaryParent: string;

  beforeEach(() => {
    globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Global fetch is forbidden in smoke tests"));
    temporaryParent = mkdtempSync(join(tmpdir(), "sushi-smoke-test-"));
  });

  afterEach(() => {
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
    rmSync(temporaryParent, { recursive: true, force: true });
  });

  it("blocks without the runtime gate and never uses fetch", async () => {
    const fetcher = vi.fn<OpenAIResponsesFetch>();

    await expect(
      runOpenAISmoke({
        args: ["--confirm-one-request"],
        environment: { OPENAI_API_KEY: syntheticApiKey },
        fetcher,
        temporaryDirectoryParent: temporaryParent,
      }),
    ).resolves.toEqual({
      status: "error",
      errorCode: "runtime_disabled",
      providerRequestAttempted: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(readdirSync(temporaryParent)).toEqual([]);
  });

  it("blocks without the one-request confirmation before configuration", async () => {
    const fetcher = vi.fn<OpenAIResponsesFetch>();

    const summary = await runOpenAISmoke({
      args: [],
      environment: enabledEnvironment,
      fetcher,
      temporaryDirectoryParent: temporaryParent,
    });

    expect(summary).toEqual({
      status: "error",
      errorCode: "confirmation_required",
      providerRequestAttempted: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(summary)).not.toContain(syntheticApiKey);
    expect(readdirSync(temporaryParent)).toEqual([]);
  });

  it("rejects enabled runtime without a key without attempting a request", async () => {
    const fetcher = vi.fn<OpenAIResponsesFetch>();

    await expect(
      runOpenAISmoke({
        args: ["--confirm-one-request"],
        environment: { OPENAI_RUNTIME_ENABLED: "true" },
        fetcher,
        temporaryDirectoryParent: temporaryParent,
      }),
    ).resolves.toEqual({
      status: "error",
      errorCode: "configuration_error",
      providerRequestAttempted: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(readdirSync(temporaryParent)).toEqual([]);
  });

  it("performs one injected fetch and emits only a safe command summary", async () => {
    const fetcher = vi
      .fn<OpenAIResponsesFetch>()
      .mockResolvedValue(strictShowMenuResponse());
    const prepareCheckoutLink = vi.fn<
      LocalConversationCheckoutFlow["prepareCheckoutLink"]
    >();

    const summary = await runOpenAISmoke({
      args: ["--confirm-one-request"],
      environment: enabledEnvironment,
      fetcher,
      temporaryDirectoryParent: temporaryParent,
      checkoutFlow: { prepareCheckoutLink },
    });

    expect(summary).toEqual({
      status: "success",
      commandType: "show_menu",
      providerRequestAttempted: true,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(prepareCheckoutLink).not.toHaveBeenCalled();
    expect(JSON.stringify(summary)).not.toContain(syntheticApiKey);
    expect(JSON.stringify(summary)).not.toContain("покажи меню");
    expect(JSON.stringify(summary)).not.toContain("synthetic-openai-smoke-user");
    expect(readdirSync(temporaryParent)).toEqual([]);
  });

  it("does not retry after an injected network failure", async () => {
    const fetcher = vi
      .fn<OpenAIResponsesFetch>()
      .mockRejectedValue(new Error(`network failure ${syntheticApiKey}`));
    const prepareCheckoutLink = vi.fn<
      LocalConversationCheckoutFlow["prepareCheckoutLink"]
    >();

    const summary = await runOpenAISmoke({
      args: ["--confirm-one-request"],
      environment: enabledEnvironment,
      fetcher,
      temporaryDirectoryParent: temporaryParent,
      checkoutFlow: { prepareCheckoutLink },
    });

    expect(summary).toEqual({
      status: "error",
      errorCode: "interpreter_unavailable",
      providerRequestAttempted: true,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(prepareCheckoutLink).not.toHaveBeenCalled();
    expect(JSON.stringify(summary)).not.toContain(syntheticApiKey);
    expect(readdirSync(temporaryParent)).toEqual([]);
  });

  it("keeps the entrypoint separate from server and forbidden integrations", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const entrypoint = readFileSync(
      new URL("../src/scripts/run-openai-smoke.ts", import.meta.url),
      "utf8",
    ).toLowerCase();
    const runner = readFileSync(
      new URL("../src/scripts/openai-smoke-runner.ts", import.meta.url),
      "utf8",
    ).toLowerCase();
    const server = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    ).toLowerCase();

    expect(packageJson.scripts["openai:smoke"]).toBe(
      "tsx src/scripts/run-openai-smoke.ts",
    );
    expect(entrypoint).toMatch(/^import "dotenv\/config";/);
    expect(server).not.toContain("openai");
    for (const source of [entrypoint, runner]) {
      expect(source).not.toContain("process-sumup-webhook");
      expect(source).not.toContain("submit-paid-order-to-poster");
      expect(source).not.toContain("createapp");
    }
  });
});
