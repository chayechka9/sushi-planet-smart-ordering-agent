import {
  AIConversationLayerService,
  type AIConversationInterpreter,
  type AIConversationLayerDependencies,
} from "../application/ai-conversation-layer.js";
import { loadOpenAIRuntimeConfig } from "../config/openai.js";
import { OpenAIConversationInterpreter } from "../integrations/openai/conversation-interpreter.js";
import {
  OpenAIResponsesHttpTransport,
  type OpenAIResponsesFetch,
  type OpenAIResponsesHttpTransportOptions,
} from "../integrations/openai/responses-http-transport.js";

export type OpenAIConversationRuntimeDependencies = Omit<
  AIConversationLayerDependencies,
  "interpreter"
>;

export interface OpenAIConversationRuntimeOptions {
  environment?: NodeJS.ProcessEnv;
  fetcher?: OpenAIResponsesFetch;
  timeoutMs?: number;
}

export type OpenAIConversationRuntime =
  | { enabled: false }
  | { enabled: true; service: AIConversationLayerService };

export type OpenAIInterpreterRuntime =
  | { enabled: false }
  | { enabled: true; interpreter: AIConversationInterpreter };

/**
 * Local opt-in composition boundary. It deliberately performs no request and
 * is not imported by the ordinary server bootstrap.
 */
export function createOpenAIConversationRuntime(
  dependencies: OpenAIConversationRuntimeDependencies,
  options: OpenAIConversationRuntimeOptions = {},
): OpenAIConversationRuntime {
  const interpreterRuntime = createOpenAIInterpreterRuntime(options);
  if (!interpreterRuntime.enabled) {
    return { enabled: false };
  }

  const service = new AIConversationLayerService({
    interpreter: interpreterRuntime.interpreter,
    conversationAgent: dependencies.conversationAgent,
    stateStore: dependencies.stateStore,
  });

  return { enabled: true, service };
}

/**
 * Provider-specific interpreter composition without application state access.
 * Construction is side-effect free; a request can happen only when a caller
 * later invokes the returned interpreter.
 */
export function createOpenAIInterpreterRuntime(
  options: OpenAIConversationRuntimeOptions = {},
): OpenAIInterpreterRuntime {
  const runtimeConfig = loadOpenAIRuntimeConfig(
    options.environment ?? process.env,
  );
  if (!runtimeConfig.enabled) {
    return { enabled: false };
  }

  const transportOptions: OpenAIResponsesHttpTransportOptions = {};
  if (options.fetcher !== undefined) {
    transportOptions.fetcher = options.fetcher;
  }
  if (options.timeoutMs !== undefined) {
    transportOptions.timeoutMs = options.timeoutMs;
  }

  const transport = new OpenAIResponsesHttpTransport(transportOptions);
  const interpreter = new OpenAIConversationInterpreter(
    runtimeConfig.openAI,
    transport,
  );
  return { enabled: true, interpreter };
}
