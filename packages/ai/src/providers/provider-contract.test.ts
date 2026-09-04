import { describe, expect, test } from "bun:test";
import { type Model, ProviderError } from "../types.js";
import {
  anthropicModel,
  collectChunks,
  DONE,
  drainAndCaptureError,
  jsonRes,
  makeProvider,
  mockFetch,
  mockFetchCapture,
  openaiModel,
  sseRes,
} from "./provider-contract.fixture.js";

describe("Provider contract — error classification", () => {
  test("ProviderError.retryable is true for transient, false for auth", () => {
    expect(new ProviderError("timeout", "transient").retryable).toBe(true);
    expect(new ProviderError("overloaded", "overload").retryable).toBe(true);
    expect(new ProviderError("bad key", "auth").retryable).toBe(false);
    expect(new ProviderError("bad request", "invalid_request").retryable).toBe(false);
  });

  test("anthropic 400 'prompt is too long' → overflow", async () => {
    const provider = makeProvider(anthropicModel);
    const restore = mockFetch(
      jsonRes({ error: { message: "prompt is too long: 200001 tokens > 200000 maximum" } }, 400),
    );
    const err = await drainAndCaptureError(
      provider.stream(anthropicModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("overflow");
  });

  test("anthropic 400 without context keywords → invalid_request", async () => {
    const provider = makeProvider(anthropicModel);
    const restore = mockFetch(jsonRes({ error: { message: "bad request body" } }, 400));
    const err = await drainAndCaptureError(
      provider.stream(anthropicModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("invalid_request");
  });

  test("openai 400 'maximum context length' → overflow", async () => {
    const provider = makeProvider(openaiModel);
    const restore = mockFetch(
      jsonRes({ error: { message: "This model's maximum context length is 128000 tokens" } }, 400),
    );
    const err = await drainAndCaptureError(
      provider.stream(openaiModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("overflow");
  });
});

describe("Provider contract — credential redaction", () => {
  test("error message redacts apiKey and contains [REDACTED]", async () => {
    const KEY = "sk-ant-secret-sentinel";
    const provider = makeProvider(anthropicModel, KEY);
    const restore = mockFetch(jsonRes({ error: { message: `echo ${KEY} in body` } }, 401));
    const err = await drainAndCaptureError(
      provider.stream(anthropicModel, [{ role: "user", text: "hi" }], { apiKey: KEY }),
    );
    restore();
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.message).not.toContain(KEY);
    expect(pe.message).toContain("[REDACTED]");
    expect(pe.detail).toContain("[REDACTED]");
    // Full serialization must not leak
    expect(JSON.stringify(pe)).not.toContain(KEY);
    // Raw error object must not be retained
    expect(pe).not.toHaveProperty("raw");
  });
});

describe("Provider contract — wire serialization", () => {
  test("anthropic serializes tool_result under user role", async () => {
    const provider = makeProvider(anthropicModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        anthropicModel,
        [
          { role: "user", text: "hi" },
          {
            role: "assistant",
            text: "",
            blocks: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
          },
          {
            role: "tool",
            text: "ok",
            blocks: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    expect(body).toBeTruthy();
    const msgs = body!.messages as Array<{ role: string; content: unknown }>;
    const toolMsg = msgs[msgs.length - 1]!;
    expect(toolMsg.role).toBe("user");
    expect(toolMsg.content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);
  });

  test("anthropic merges consecutive user messages into one wire message", async () => {
    const provider = makeProvider(anthropicModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        anthropicModel,
        [
          {
            role: "assistant",
            text: "",
            blocks: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
          },
          {
            role: "tool",
            text: "ok",
            blocks: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
          // Stream-rule reminder / steer lands as a user text message right
          // after the tool-result batch — must merge, not alternate-break.
          { role: "user", text: "<system-reminder>fix and retry</system-reminder>" },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    const msgs = body!.messages as Array<{ role: string; content: unknown }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("assistant");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "text", text: "<system-reminder>fix and retry</system-reminder>" },
    ]);
  });

  test("openai-completions serializes image blocks as image_url parts", async () => {
    const provider = makeProvider(openaiModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        openaiModel,
        [
          {
            role: "user",
            text: "",
            blocks: [
              { type: "text", text: "look" },
              { type: "image", mediaType: "image/png", base64: "aGk=" },
            ],
          },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    const msgs = body!.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
      ],
    });
  });

  test("openai-completions tool_result carries images as content parts", async () => {
    const provider = makeProvider(openaiModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        openaiModel,
        [
          {
            role: "assistant",
            text: "",
            blocks: [{ type: "tool_use", id: "t1", name: "read_image", input: {} }],
          },
          {
            role: "tool",
            text: "",
            blocks: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: "[image attached]",
                images: [{ type: "image", mediaType: "image/jpeg", base64: "am9o" }],
              },
            ],
          },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    const msgs = body!.messages as Array<{ role: string; content: unknown }>;
    const toolMsg = msgs[msgs.length - 1]!;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toEqual([
      { type: "text", text: "[image attached]" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,am9o" } },
    ]);
  });

  test("openai-responses serializes user images as input_image", async () => {
    const responsesModel: Model = { ...openaiModel, api: "openai-responses" };
    const provider = makeProvider(responsesModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        responsesModel,
        [
          {
            role: "user",
            text: "",
            blocks: [
              { type: "text", text: "look" },
              { type: "image", mediaType: "image/png", base64: "aGk=" },
            ],
          },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    const input = body!.input as Array<{ type: string; role?: string; content: unknown }>;
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,aGk=" },
      ],
    });
  });

  test("openai-responses assistant text survives when blocks are thinking-only", async () => {
    const responsesModel: Model = { ...openaiModel, api: "openai-responses" };
    const provider = makeProvider(responsesModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        responsesModel,
        [
          {
            role: "assistant",
            text: "the answer",
            blocks: [{ type: "thinking", text: "reasoning", signature: "sig" }],
          },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    const input = body!.input as Array<{
      type: string;
      role?: string;
      status?: string;
      content: unknown;
    }>;
    expect(input[0]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "the answer" }],
      status: "completed",
    });
  });

  test("anthropic assistant text survives when blocks are thinking-only", async () => {
    const provider = makeProvider(anthropicModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        anthropicModel,
        [
          {
            role: "assistant",
            text: "the answer",
            blocks: [{ type: "thinking", text: "reasoning", signature: "sig" }],
          },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    const messages = body!.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]!.content).toEqual([
      { type: "thinking", thinking: "reasoning", signature: "sig" },
      { type: "text", text: "the answer" },
    ]);
  });

  test("openai-responses tool_result carries images as input_image parts", async () => {
    const responsesModel: Model = { ...openaiModel, api: "openai-responses" };
    const provider = makeProvider(responsesModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        responsesModel,
        [
          {
            role: "tool",
            text: "",
            blocks: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: "[image attached]",
                images: [{ type: "image", mediaType: "image/jpeg", base64: "am9o" }],
              },
            ],
          },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    const input = body!.input as Array<{
      type: string;
      call_id?: string;
      output?: unknown;
    }>;
    expect(input[0]).toEqual({
      type: "function_call_output",
      call_id: "t1",
      output: [
        { type: "input_text", text: "[image attached]" },
        { type: "input_image", image_url: "data:image/jpeg;base64,am9o" },
      ],
    });
  });

  test("openai-completions serializes responseFormat as response_format (F5)", async () => {
    const provider = makeProvider(openaiModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    await collectChunks(
      provider.stream(openaiModel, [{ role: "user", text: "hi" }], {
        apiKey: "test-key",
        responseFormat: { name: "result", schema },
      }),
    );
    capture.restore();
    const body = capture.getBody();
    expect(body!.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "result", schema, strict: true },
    });
  });

  test("openai-completions degrades responseFormat to json_object on DeepSeek (F5)", async () => {
    const deepseekModel: Model = {
      ...openaiModel,
      compat: { thinkingFormat: "deepseek" as const, maxTokensField: "max_tokens" as const },
    };
    const provider = makeProvider(deepseekModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(deepseekModel, [{ role: "user", text: "hi" }], {
        apiKey: "test-key",
        responseFormat: { name: "result", schema: { type: "object" } },
      }),
    );
    capture.restore();
    const body = capture.getBody();
    expect(body!.response_format).toEqual({ type: "json_object" });
  });

  test("openai-responses serializes responseFormat as text.format (F5)", async () => {
    const responsesModel: Model = { ...openaiModel, api: "openai-responses" };
    const provider = makeProvider(responsesModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    await collectChunks(
      provider.stream(responsesModel, [{ role: "user", text: "hi" }], {
        apiKey: "test-key",
        responseFormat: { name: "result", schema },
      }),
    );
    capture.restore();
    const body = capture.getBody();
    expect(body!.text).toEqual({
      format: { type: "json_schema", name: "result", schema, strict: true },
    });
  });

  test("anthropic injects a report_result tool for responseFormat (F5)", async () => {
    const provider = makeProvider(anthropicModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    await collectChunks(
      provider.stream(anthropicModel, [{ role: "user", text: "hi" }], {
        apiKey: "test-key",
        responseFormat: { name: "result", schema },
      }),
    );
    capture.restore();
    const body = capture.getBody();
    const tools = body!.tools as Array<Record<string, unknown>>;
    expect(tools).toContainEqual({
      name: "report_result",
      description: "Report the final result conforming to the required output schema",
      input_schema: schema,
    });
  });

  test("anthropic serializes tool schemas, defaults missing inputSchema to {}", async () => {
    const provider = makeProvider(anthropicModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(anthropicModel, [{ role: "user", text: "list files" }], {
        apiKey: "test-key",
        tools: [
          { name: "ls", description: "List a directory", inputSchema: { type: "object" } },
          { name: "read", description: "Read a file" },
        ],
      }),
    );
    capture.restore();

    const body = capture.getBody();
    const tools = body!.tools as Array<{
      name: string;
      description: string;
      input_schema: unknown;
    }>;
    expect(tools).toContainEqual({
      name: "ls",
      description: "List a directory",
      input_schema: { type: "object" },
    });
    // Missing inputSchema defaults to {}, tool is not dropped
    expect(tools).toContainEqual({ name: "read", description: "Read a file", input_schema: {} });
  });
});
