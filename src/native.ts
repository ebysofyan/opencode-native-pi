import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ImageContent,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";

type RecordValue = Record<string, unknown>;
export type NativeTool = { name: string; piName: string; description: string; parameters: Tool["parameters"] };
export type NativeTurn = { systemPrompt: string; messages: RecordValue[]; tools: NativeTool[] };
const HANDOFF = "PI_BRIDGE_TOOL_HANDOFF";
/** Adapter rejection that ends the OpenCode loop once Pi owns the turn. */
const CONTINUATION_GUARD = "Pi owns continuation; stop the OpenCode loop";

// This adapter declares tools but never executes them. Pi owns every side effect.
export const NATIVE_PLUGIN_SOURCE = String.raw`
import { readFileSync } from "node:fs";
const turn = JSON.parse(readFileSync(new URL("../turn.json", import.meta.url), "utf8"));
export default {
  id: "pi-native-tools",
  setup: async (ctx) => {
    const registrations = [];
    let handedOff = false;
    try {
      registrations.push(await ctx.tool.transform((draft) => {
        for (const tool of turn.tools) draft.add({
          name: tool.name, description: tool.description, input: tool.parameters,
          options: { permission: "pi_bridge", codemode: false },
          execute: async () => { handedOff = true; throw new Error("PI_BRIDGE_TOOL_HANDOFF"); },
        });
      }));
      registrations.push(await ctx.tool.hook("execute.before", () => {
        handedOff = true;
        throw new Error("PI_BRIDGE_TOOL_HANDOFF");
      }));
      registrations.push(await ctx.session.hook("context", (event) => {
        if (handedOff) throw new Error("${CONTINUATION_GUARD}");
        event.system = [{ type: "text", text: turn.systemPrompt }];
        event.messages = structuredClone(turn.messages);
        // OpenCode's free models require its native read declaration. It stays
        // approval-gated and the execute.before guard also prevents execution.
        const read = event.tools.read;
        event.tools = read ? { read: { ...read, description: "OpenCode internal tool. Do not call this tool unless Pi has supplied its schema." } } : {};
        for (const tool of turn.tools) event.tools[tool.name] = { description: tool.description, input: tool.parameters };
      }));
    } catch (error) {
      for (const registration of registrations.reverse()) await registration.dispose();
      throw error;
    }
    return async () => { for (const registration of registrations.reverse()) await registration.dispose(); };
  },
};
`;

function record(value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid OpenCode event object");
  return value as RecordValue;
}

function validateImage(image: ImageContent): ImageContent {
  const data = image.data.replace(/\s/g, "");
  if (!/^image\/[a-z0-9.+-]+$/i.test(image.mimeType)) throw new Error("Unsupported image MIME type");
  if (!data || data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || Buffer.from(data, "base64").length === 0) throw new Error("Invalid base64 image data");
  return { ...image, data };
}

export function buildNativeTurn(context: Context, supportsImages: boolean): NativeTurn {
  const hasSystem = context.messages.some((message) => message.role === "system");
  const tools = (hasSystem ? getCurrentTools(context.messages) : context.tools ?? []).map((tool, index) => ({
    name: /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) ? tool.name : `pi_${index}_${tool.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40)}`,
    piName: tool.name,
    description: `Pi tool ${tool.name}: ${tool.description}`,
    parameters: tool.parameters,
  }));
  const aliases = new Map(tools.map((tool) => [tool.piName, tool.name]));
  const messages: RecordValue[] = [];
  for (const message of context.messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content.flatMap((part): RecordValue[] => {
        if (part.type === "text") return [{ type: "text", text: part.text }];
        if (!supportsImages) throw new Error("The selected OpenCode model does not support image input");
        const image = validateImage(part);
        return [{ type: "media", mediaType: image.mimeType, data: image.data }];
      });
      messages.push({ role: "user", content });
    } else if (message.role === "assistant") {
      const content = message.content.flatMap((part): RecordValue[] => {
        if (part.type === "text") return [{ type: "text", text: part.text }];
        if (part.type === "thinking") return [{ type: "reasoning", text: part.thinking }];
        return [{ type: "tool-call", id: part.id, name: aliases.get(part.name) ?? part.name, input: part.arguments, providerExecuted: false }];
      });
      if (content.length) messages.push({ role: "assistant", content });
    } else {
      const content = message.content.map((part) => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (!supportsImages) throw new Error("The selected OpenCode model does not support image tool results");
        const image = validateImage(part);
        return { type: "file", mime: image.mimeType, uri: `data:${image.mimeType};base64,${image.data}` };
      });
      messages.push({ role: "tool", content: [{
        type: "tool-result", id: message.toolCallId, name: aliases.get(message.toolName) ?? message.toolName,
        result: message.isError ? { type: "error", value: content } : { type: "content", value: content },
        providerExecuted: false,
      }] });
    }
  }
  const systemPrompt = hasSystem ? getCurrentSystemPrompt(context.messages) : context.systemPrompt ?? "";
  return {
    systemPrompt: `${systemPrompt}\n\nYou are the assistant running inside Pi. Use the tools with their exact declared names for Pi operations; their results arrive in the conversation. Tools described as Pi tools are executed by Pi. Never emit XML tool markers or call tools marked OpenCode internal. Give a final answer or call a tool; reasoning alone is not a response.`,
    messages,
    tools,
  };
}

/** Decode SSE incrementally, including split UTF-8, CRLF and multiline data. */
export async function* nativeEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<RecordValue> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let data: string[] = [];
  let frameSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 4_000_000) throw new Error("OpenCode event exceeds 4 MB");
      if (done && pending && !pending.endsWith("\n")) pending += "\n";
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line.startsWith("data:")) {
          frameSize += line.length;
          if (frameSize > 4_000_000) throw new Error("OpenCode event exceeds 4 MB");
          data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!line && data.length) {
          yield record(JSON.parse(data.join("\n")));
          data = []; frameSize = 0;
        }
      }
      if (done) {
        if (data.length) yield record(JSON.parse(data.join("\n")));
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type NativeServer = { child: ChildProcess; closed: Promise<void>; base: string; authorization: string };
async function startServer(directory: string, signal: AbortSignal, env?: SimpleStreamOptions["env"]): Promise<NativeServer> {
  signal.throwIfAborted();
  const inheritedEnv = { ...process.env, ...env };
  delete inheritedEnv.OPENCODE_CONFIG;
  delete inheritedEnv.OPENCODE_CONFIG_CONTENT;
  delete inheritedEnv.OPENCODE_SERVER_PASSWORD;
  const child = spawn(env?.OPENCODE_PI_BIN ?? process.env.OPENCODE_PI_BIN?.trim() ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...inheritedEnv, PWD: directory, OPENCODE_CONFIG_DIR: join(directory, "config"), XDG_CONFIG_HOME: join(directory, "xdg-config"), XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"), XDG_CACHE_HOME: join(directory, "cache"), OPENCODE_DISABLE_PROJECT_CONFIG: "0", OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_UPDATE_CHECK: "1" },
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const abort = () => { child.kill("SIGTERM"); };
  signal.addEventListener("abort", abort, { once: true });
  void closed.then(() => signal.removeEventListener("abort", abort));
  try {
    return await new Promise<NativeServer>((resolve, reject) => {
      let logs = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("OpenCode server startup timed out")); }, 10_000);
      const cleanup = () => { clearTimeout(timer); child.stdout?.removeListener("data", onData); child.stderr?.removeListener("data", onData); };
      const onData = (chunk: Buffer) => {
        logs = (logs + chunk.toString("utf8")).slice(-8192);
        const base = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        const password = logs.match(/server password (\S+)/)?.[1];
        if (!base || !password) return;
        cleanup();
        // Do not forward server output: it contains the private server password.
        child.stdout?.resume(); child.stderr?.resume();
        resolve({ child, closed, base, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` });
      };
      child.stdout?.on("data", onData); child.stderr?.on("data", onData);
      child.once("error", () => { cleanup(); reject(new Error("Could not start OpenCode. This transport requires OpenCode 2.1 or newer.")); });
      void closed.then(() => { cleanup(); reject(new Error("OpenCode server exited before startup completed")); });
      if (signal.aborted) abort();
    });
  } catch (error) {
    await stopServer({ child, closed, base: "", authorization: "" });
    throw error;
  }
}

async function stopServer(server: NativeServer): Promise<void> {
  server.child.kill("SIGTERM");
  const timer = setTimeout(() => { server.child.kill("SIGKILL"); }, 2000);
  try { await server.closed; } finally { clearTimeout(timer); }
}

/** One native OpenCode step; Pi owns tool execution and every following step. */
export function streamNativeOpenCode(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), content: [], stopReason: "pending",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const controller = new AbortController();
    const abort = () => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", abort, { once: true });
    if (options?.signal?.aborted) abort();
    const timeout = options?.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 180_000;
    const timer = setTimeout(() => controller.abort(new Error(`OpenCode timed out after ${timeout}ms`)), timeout);
    let directory: string | undefined;
    let server: NativeServer | undefined;
    let sessionID: string | undefined;
    const blocks = new Map<string, number>();
    const closedBlocks = new Set<string>();
    const calls = new Map<string, { call: ToolCall; index: number; called: boolean; blocked: boolean; json: string }>();
    const finishBlocks = (thinkingOnly = false) => {
      for (const [key, index] of blocks) {
        if (thinkingOnly && !key.startsWith("true:")) continue;
        const part = output.content[index];
        if (part.type === "text") stream.push({ type: "text_end", contentIndex: index, content: part.text, partial: output });
        if (part.type === "thinking") stream.push({ type: "thinking_end", contentIndex: index, content: part.thinking, partial: output });
        blocks.delete(key); closedBlocks.add(key);
      }
    };
    const request = async (path: string, method = "GET", body?: unknown, signal = controller.signal): Promise<Response> => {
      if (!server) throw new Error("OpenCode server is not running");
      const response = await (options?.fetch ?? fetch)(`${server.base}${path}`, {
        method, signal, redirect: "error", headers: { Authorization: server.authorization, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`OpenCode local API ${method} ${path.split("?")[0]} failed (${response.status})`);
      return response;
    };
    try {
      stream.push({ type: "start", partial: output });
      controller.signal.throwIfAborted();
      let turn = buildNativeTurn(context, model.input.includes("image"));
      const replacement = await options?.onPayload?.(turn, model);
      if (replacement !== undefined) {
        const candidate = record(replacement);
        if (typeof candidate.systemPrompt !== "string" || !Array.isArray(candidate.messages) || !Array.isArray(candidate.tools)) throw new Error("Invalid OpenCode payload replacement");
        turn = candidate as NativeTurn;
      }
      const aliases = new Map(turn.tools.map((tool) => [tool.name, tool.piName]));
      const allowed = new Set((context.messages.some((m) => m.role === "system") ? getCurrentTools(context.messages) : context.tools ?? []).map((tool) => tool.name));
      if (allowed.has("read")) aliases.set("read", "read");
      directory = await realpath(await mkdtemp(join(tmpdir(), "pi-opencode-native-")));
      await mkdir(join(directory, ".opencode", "agents"), { recursive: true });
      await mkdir(join(directory, "adapter"));
      const writes = await Promise.allSettled([
        writeFile(join(directory, "turn.json"), JSON.stringify(turn), { mode: 0o600 }),
        writeFile(join(directory, "adapter", "package.json"), JSON.stringify({ name: "pi-native-tools", type: "module", exports: { "./server": "./index.mjs" } })),
        writeFile(join(directory, "adapter", "index.mjs"), NATIVE_PLUGIN_SOURCE),
        writeFile(join(directory, ".opencode", "opencode.json"), JSON.stringify({ plugins: [join(directory, "adapter")] })),
        writeFile(join(directory, ".opencode", "agents", "pi-model.md"), `---\ndescription: Pi native model transport\nmode: primary\npermissions:\n  - action: "*"\n    resource: "*"\n    effect: deny\n  - action: read\n    resource: "*"\n    effect: ask\n  - action: pi_bridge\n    resource: "*"\n    effect: allow\n---\nPi owns tool execution and continuation.\n`),
      ]);
      for (const result of writes) if (result.status === "rejected") throw result.reason;
      server = await startServer(directory, controller.signal, options?.env);
      const separator = model.id.indexOf("/");
      if (separator < 1) throw new Error("OpenCode model ID must have provider/model form");
      const variant = model.thinkingLevelMap?.[options?.reasoning ?? "off"];
      const selectedModel = { providerID: model.id.slice(0, separator), id: model.id.slice(separator + 1), ...(typeof variant === "string" ? { variant } : {}) };
      const created = record(await (await request("/api/session", "POST", { title: "Pi model turn", agent: "pi-model", model: selectedModel, location: { directory } })).json());
      const id = record(created.data).id;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid OpenCode session ID");
      sessionID = id;
      const response = await request("/api/event");
      await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
      if (!response.body) throw new Error("OpenCode returned no event stream");
      await request(`/api/session/${sessionID}/prompt`, "POST", { text: "Respond to the Pi conversation supplied by the native adapter." });
      let ended = false;
      for await (const event of nativeEvents(response.body)) {
        await options?.onProviderStreamEvent?.(event, model);
        if (typeof event.type !== "string") throw new Error("Invalid OpenCode event type");
        if (event.type === "effect/http-api/stream/failure") throw new Error("OpenCode event stream failed");
        if (event.data === undefined || event.data === null) continue;
        const data = record(event.data);
        if (data.sessionID !== sessionID) continue;
        const type = event.type;
        if (type === "permission.asked") {
          if (typeof data.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(data.id)) throw new Error("Invalid OpenCode permission ID");
          await request(`/api/session/${sessionID}/permission/${data.id}/reply`, "POST", { decision: "reject", message: "Pi owns tool execution" });
        } else if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(type)) {
          const thinking = type.includes(".reasoning.");
          if (!thinking) finishBlocks(true);
          const key = `${thinking}:${data.assistantMessageID}:${data.ordinal}`;
          if (type.endsWith(".ended") && closedBlocks.has(key)) continue;
          let index = blocks.get(key);
          if (index === undefined) {
            index = output.content.length;
            output.content.push(thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" });
            blocks.set(key, index);
            if (thinking) stream.push({ type: "thinking_start", contentIndex: index, partial: output });
            else stream.push({ type: "text_start", contentIndex: index, partial: output });
          }
          const part = output.content[index];
          const previous = part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : "";
          if (type.endsWith(".ended") && typeof data.text === "string" && !data.text.startsWith(previous)) throw new Error("OpenCode rewrote an already streamed text block");
          const delta = type.endsWith(".delta") ? data.delta : type.endsWith(".ended") && typeof data.text === "string" ? data.text.slice(previous.length) : "";
          if (typeof delta !== "string") throw new Error("Invalid OpenCode text delta");
          if (delta && part.type === "text") { part.text += delta; stream.push({ type: "text_delta", contentIndex: index, delta, partial: output }); }
          if (delta && part.type === "thinking") { part.thinking += delta; stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: output }); }
          if (type.endsWith(".ended")) {
            if (part.type === "text") stream.push({ type: "text_end", contentIndex: index, content: part.text, partial: output });
            if (part.type === "thinking") stream.push({ type: "thinking_end", contentIndex: index, content: part.thinking, partial: output });
            blocks.delete(key); closedBlocks.add(key);
          }
        } else if (type === "session.tool.input.started") {
          finishBlocks(true);
          const name = typeof data.name === "string" ? aliases.get(data.name) : undefined;
          if (!name || !allowed.has(name)) throw new Error(`OpenCode requested unavailable Pi tool: ${String(data.name)}`);
          if (typeof data.id !== "string" || calls.has(data.id)) throw new Error("Invalid OpenCode tool-call ID");
          const call: ToolCall = { type: "toolCall", id: data.id, name, arguments: {} };
          const index = output.content.length;
          output.content.push(call); calls.set(data.id, { call, index, called: false, blocked: false, json: "" });
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        } else if (type === "session.tool.input.delta") {
          const call = calls.get(String(data.id));
          if (!call || typeof data.delta !== "string") throw new Error("Invalid OpenCode tool input delta");
          call.json += data.delta;
          call.call.arguments = parseStreamingJson<ToolCall["arguments"]>(call.json);
          stream.push({ type: "toolcall_delta", contentIndex: call.index, delta: data.delta, partial: output });
        } else if (type === "session.tool.input.ended") {
          const call = calls.get(String(data.id));
          if (!call || typeof data.text !== "string" || !data.text.startsWith(call.json)) throw new Error("Invalid OpenCode final tool input");
          const delta = data.text.slice(call.json.length);
          call.json = data.text;
          call.call.arguments = record(JSON.parse(data.text)) as ToolCall["arguments"];
          if (delta) stream.push({ type: "toolcall_delta", contentIndex: call.index, delta, partial: output });
        } else if (type === "session.tool.called") {
          const call = calls.get(String(data.id));
          if (!call) throw new Error("OpenCode called an undeclared tool");
          if (data.executed === true) throw new Error("OpenCode provider executed a tool instead of handing it to Pi");
          call.call.arguments = record(data.input) as ToolCall["arguments"];
          if (!call.json) stream.push({ type: "toolcall_delta", contentIndex: call.index, delta: JSON.stringify(call.call.arguments), partial: output });
          call.called = true;
        } else if (type === "session.tool.failed") {
          const call = calls.get(String(data.id));
          const error = record(data.error);
          if (!call || (error.message !== HANDOFF && error.type !== "permission.rejected")) throw new Error("OpenCode tool was not safely handed off to Pi");
          call.blocked = true;
        } else if (type === "session.tool.completed") {
          throw new Error("OpenCode executed a tool instead of handing it to Pi");
        } else if (type === "session.step.failed" || type === "session.execution.failed") {
          const error = record(data.error);
          const message = typeof error.message === "string" ? error.message : "OpenCode generation failed";
          // Accept our loop guard only after every tool handoff was confirmed.
          if (message !== CONTINUATION_GUARD || !calls.size || [...calls.values()].some(({ called, blocked }) => !called || !blocked)) throw new Error(message);
          finishBlocks();
          for (const { call, index } of calls.values()) stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: output });
          output.stopReason = "toolUse";
          ended = true;
          break;
        } else if (type === "session.step.ended") {
          const tokens = data.tokens ? record(data.tokens) : {};
          const cache = tokens.cache ? record(tokens.cache) : {};
          output.usage.input = Number(tokens.input ?? 0);
          output.usage.output = Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
          output.usage.cacheRead = Number(cache.read ?? 0); output.usage.cacheWrite = Number(cache.write ?? 0);
          output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          calculateCost(model, output.usage);
          finishBlocks();
          if ([...calls.values()].some(({ called, blocked }) => !called || !blocked)) throw new Error("OpenCode tool handoff was incomplete; Pi did not execute it");
          if (!calls.size && !output.content.some((part) => part.type === "text" && part.text.trim())) throw new Error("OpenCode returned reasoning only or an empty reply; no final answer or Pi tool call");
          if (calls.size && data.finish !== "tool-calls") throw new Error("OpenCode returned an inconsistent tool handoff");
          if (!calls.size && data.finish !== "stop" && data.finish !== "length") throw new Error(`OpenCode stopped unexpectedly: ${String(data.finish)}`);
          for (const { call, index } of calls.values()) stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: output });
          output.stopReason = calls.size ? "toolUse" : data.finish === "length" ? "length" : "stop";
          ended = true;
          break;
        }
      }
      if (!ended) throw new Error("OpenCode event stream disconnected before the turn completed");
      // Stop the native loop before returning Pi tool calls. No model retry or
      // native execution is allowed to race Pi's normal tool pipeline.
      await request(`/api/session/${sessionID}/interrupt`, "POST", {});
    } catch (error) {
      finishBlocks();
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = controller.signal.aborted && !options?.signal?.aborted ? String(controller.signal.reason instanceof Error ? controller.signal.reason.message : "OpenCode request aborted") : error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer); options?.signal?.removeEventListener("abort", abort);
      if (server) {
        if (sessionID) await request(`/api/session/${sessionID}`, "DELETE", undefined, AbortSignal.timeout(2000)).catch(() => {});
        await stopServer(server);
      }
      controller.abort();
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (output.stopReason === "error" || output.stopReason === "aborted") stream.push({ type: "error", reason: output.stopReason, error: output });
      else stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    }
  })();
  return stream;
}
