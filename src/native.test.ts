import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { buildNativeTurn, nativeEvents, NATIVE_PLUGIN_SOURCE, streamNativeOpenCode } from "./native.js";
import { streamOpenCode } from "./index.js";

const model: Model<Api> = {
  id: "opencode/fake-free", name: "Fake", api: "opencode-cli-runner", provider: "opencode-cli", baseUrl: "",
  reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const read: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
function context(tools: Tool[] = [read]): Context {
  return { messages: [{ role: "system", content: "Pi system prompt", toolsAdded: tools, timestamp: 0 }, { role: "user", content: "Hello", timestamp: 1 }] };
}
function event(type: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, data: { sessionID: "ses_fake", ...data } };
}
const ended = event("session.step.ended", { finish: "stop", tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } } });

async function withServer<T>(events: unknown[], run: (options: SimpleStreamOptions, directory: string) => Promise<T>, extra = ""): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "pi-native-server-test-"));
  const bin = join(directory, "opencode-fake.cjs");
  writeFileSync(bin, `#!/usr/bin/env node
if(process.argv[2]==="--version"){console.log("opencode v2.1.0");process.exit(0);}
const http=require("node:http"),fs=require("node:fs"),path=require("node:path");
let output,started=false;
const requests=[];
const events=${JSON.stringify(events)};
const server=http.createServer((req,res)=>{
 requests.push({method:req.method,path:req.url});
 fs.writeFileSync(${JSON.stringify(join(directory, "requests.json"))},JSON.stringify(requests));
 if(req.headers.authorization!=="Basic "+Buffer.from("opencode:test-private-password").toString("base64")){res.writeHead(401).end();return;}
 if(req.url==="/api/session"&&req.method==="POST"){res.setHeader("content-type","application/json");res.end(JSON.stringify({data:{id:"ses_fake"}}));return;}
 if(req.url==="/api/event"){
  output=res;res.setHeader("content-type","text/event-stream");res.flushHeaders();return;
 }
 if(req.url==="/api/session/ses_fake/prompt"){
  res.end("{}");
  if(started)return;started=true;
  ${extra || `let i=0;const timer=setInterval(()=>{if(i>=events.length){clearInterval(timer);output.end();return;}output.write("data: "+JSON.stringify(events[i++])+"\\n\\n");},5);`}
  return;
 }
 res.end("{}");
});
server.listen(0,"127.0.0.1",()=>{
 fs.writeFileSync(${JSON.stringify(join(directory, "launch.json"))},JSON.stringify({cwd:process.cwd(),env:{config:process.env.OPENCODE_CONFIG_DIR,data:process.env.XDG_DATA_HOME,state:process.env.XDG_STATE_HOME,cache:process.env.XDG_CACHE_HOME}}));
 console.log("server listening on http://127.0.0.1:"+server.address().port);
 console.log("server password test-private-password");
});
process.on("SIGTERM",()=>{output?.end();server.close(()=>process.exit(0));});
`, "utf8");
  chmodSync(bin, 0o755);
  try { return await run({ env: { OPENCODE_NATIVE_PI_BIN: bin }, timeoutMs: 5000 }, directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
async function collect(events: unknown[], ctx = context()): Promise<AssistantMessageEvent[]> {
  return withServer(events, async (options) => {
    const result: AssistantMessageEvent[] = [];
    for await (const item of streamNativeOpenCode(model, ctx, options)) result.push(item);
    return result;
  });
}

test("native SSE decoder handles split UTF-8, CRLF, multiline frames and final frame", async () => {
  const bytes = new TextEncoder().encode('event: message\r\ndata: {"type":"text",\r\ndata: "data":{"text":"α😀"}}\r\n\r\ndata: {"type":"last","data":{}}');
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const result = [];
  for await (const item of nativeEvents(body)) result.push(item);
  assert.deepEqual(result, [{ type: "text", data: { text: "α😀" } }, { type: "last", data: {} }]);
});

test("native conversion replays system/tool deltas, messages and image results without markers", () => {
  const ctx = context();
  ctx.messages.push(
    { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "fixture.png" } }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], isError: false, timestamp: 3 },
    { role: "system", content: "latest", sections: { style: "concise" }, toolsRemoved: [{ name: "read" }], toolsAdded: [{ ...read, name: "ffgrep" }], timestamp: 4 },
    { role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], timestamp: 5 },
  );
  const turn = buildNativeTurn(ctx, true);
  assert.match(turn.systemPrompt, /Pi system prompt\n\nlatest\n\nconcise/);
  assert.deepEqual(turn.tools.map((tool) => tool.piName), ["ffgrep"]);
  assert.equal(turn.messages.length, 4);
  assert.ok(!JSON.stringify(turn).includes("<pi_tool_call>"));
  assert.match(JSON.stringify(turn.messages), /"type":"media"/);
  assert.match(JSON.stringify(turn.messages), /data:image\/png;base64,aGVsbG8=/);
  assert.throws(() => buildNativeTurn(ctx, false), /does not support image/);
});

test("native text deltas arrive before completion, stay balanced and do not duplicate ended text", async () => {
  const ack = join(mkdtempSync(join(tmpdir(), "pi-native-ack-")), "ack");
  try {
    await withServer([], async (options, dir) => {
      const result: AssistantMessageEvent[] = [];
      let observed = 0;
      for await (const item of streamNativeOpenCode(model, context(), { ...options, onProviderStreamEvent() { observed++; } })) {
        result.push(item);
        if (item.type === "text_delta") writeFileSync(ack, "received");
      }
      assert.deepEqual(result.map((item) => item.type), ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
      const done = result.at(-1);
      assert.equal(done?.type, "done");
      if (done?.type === "done") {
        assert.deepEqual(done.message.content, [{ type: "text", text: "Hello world" }]);
        assert.deepEqual({ ...done.message.usage, cost: undefined }, { input: 10, output: 7, cacheRead: 3, cacheWrite: 4, totalTokens: 24, cost: undefined });
      }
      assert.ok(observed >= 4);
      const requests = JSON.parse(readFileSync(join(dir, "requests.json"), "utf8"));
      assert.ok(requests.some((req: { method: string }) => req.method === "DELETE"));
      const launch = JSON.parse(readFileSync(join(dir, "launch.json"), "utf8"));
      assert.equal(existsSync(launch.cwd), false, "isolated turn files removed before stream closes");
      for (const value of Object.values(launch.env)) assert.ok(String(value).startsWith(launch.cwd));
    }, `output.write("data: "+JSON.stringify(${JSON.stringify(event("session.text.delta", { ordinal: 0, delta: "Hello " }))})+"\\n\\n");
const deadline=setTimeout(()=>{output.end();},2000);
const poll=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(ack)}))return;clearInterval(poll);clearTimeout(deadline);
for(const e of ${JSON.stringify([event("session.text.delta", { ordinal: 0, delta: "world" }), event("session.text.ended", { ordinal: 0, text: "Hello world" }), ended])}) output.write("data: "+JSON.stringify(e)+"\\n\\n");},10);`);
  } finally { rmSync(join(ack, ".."), { recursive: true, force: true }); }
});

test("native declarations preserve Pi tool names used in system instructions and history", () => {
  const turn = buildNativeTurn(context([read, { ...read, name: "bash" }, { ...read, name: "ffgrep" }]), false);
  assert.deepEqual(turn.tools.map(({ name, piName }) => ({ name, piName })), [
    { name: "read", piName: "read" }, { name: "bash", piName: "bash" }, { name: "ffgrep", piName: "ffgrep" },
  ]);
  assert.ok(!turn.systemPrompt.includes("pi_*"));
});

test("native bash requests use their declared name while undeclared bash stays blocked", async () => {
  const events = await collect([
    event("session.tool.input.started", { id: "call_bash", name: "bash" }),
    event("session.tool.called", { id: "call_bash", input: { command: "printf SYNTHETIC" } }),
    event("session.tool.failed", { id: "call_bash", error: { message: "PI_BRIDGE_TOOL_HANDOFF" } }),
    event("session.step.ended", { finish: "tool-calls" }),
  ], context([{ name: "bash", description: "Run command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }]));
  const done = events.at(-1);
  if (done?.type !== "done") assert.fail("bash must reach Pi");
  assert.equal(done.reason, "toolUse");
  assert.deepEqual(done.message.content, [{ type: "toolCall", id: "call_bash", name: "bash", arguments: { command: "printf SYNTHETIC" } }]);
  const rejected = await collect([event("session.tool.input.started", { id: "call_bash", name: "bash" })], context([read]));
  assert.equal(rejected.at(-1)?.type, "error");
});

test("native images are validated before starting OpenCode", () => {
  for (const [mimeType, data] of [["text/html", "aGVsbG8="], ["image/png", "not base64!"], ["image/png", ""]]) {
    const ctx: Context = { messages: [{ role: "user", timestamp: 1, content: [{ type: "image", mimeType, data }] }] };
    assert.throws(() => buildNativeTurn(ctx, true), /image/);
  }
});

test("native thinking ends when answer starts, rather than inflating thinking duration", async () => {
  const events = await collect([
    event("session.reasoning.delta", { ordinal: 0, delta: "Checking" }),
    event("session.text.delta", { ordinal: 1, delta: "OK" }),
    event("session.reasoning.ended", { ordinal: 0, text: "Checking" }),
    ended,
  ]);
  assert.deepEqual(events.map((item) => item.type), ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"]);
});

test("native final tool input fills a missing streamed suffix and preserves Pi ffgrep name", async () => {
  const events = await collect([
    event("session.tool.input.started", { id: "call_1", name: "ffgrep" }),
    event("session.tool.input.delta", { id: "call_1", delta: '{"pattern":' }),
    event("session.tool.input.ended", { id: "call_1", text: '{"pattern":"needle"}' }),
    event("session.tool.called", { id: "call_1", input: { pattern: "needle" } }),
    event("session.tool.failed", { id: "call_1", error: { type: "unknown", message: "PI_BRIDGE_TOOL_HANDOFF" } }),
    event("session.step.ended", { finish: "tool-calls" }),
  ], context([{ name: "ffgrep", description: "Find a string", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } }]));
  const done = events.at(-1);
  if (done?.type !== "done") assert.fail("missing tool handoff");
  assert.deepEqual(done.message.content, [{ type: "toolCall", id: "call_1", name: "ffgrep", arguments: { pattern: "needle" } }]);
  const deltas = events.filter((item) => item.type === "toolcall_delta");
  assert.equal(deltas.map((item) => item.delta).join(""), '{"pattern":"needle"}');
});

test("registered v2 provider dispatches to native SSE instead of the legacy CLI", async () => {
  await withServer([event("session.text.delta", { ordinal: 0, delta: "Native transport" }), ended], async (options) => {
    const previous = process.env.OPENCODE_NATIVE_PI_BIN;
    process.env.OPENCODE_NATIVE_PI_BIN = options.env?.OPENCODE_NATIVE_PI_BIN;
    try {
      const message = await streamOpenCode(model, context(), options).result();
      assert.equal(message.stopReason, "stop");
      assert.deepEqual(message.content, [{ type: "text", text: "Native transport" }]);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_NATIVE_PI_BIN;
      else process.env.OPENCODE_NATIVE_PI_BIN = previous;
    }
  });
});

test("native calls use Pi names and only finish after confirmed handoff", async () => {
  const events = await collect([
    event("session.tool.input.started", { id: "call_1", name: "read" }),
    event("session.tool.input.delta", { id: "call_1", delta: '{"path":"fixture.txt"}' }),
    event("session.tool.called", { id: "call_1", input: { path: "fixture.txt" }, executed: false }),
    event("session.tool.failed", { id: "call_1", error: { type: "unknown", message: "PI_BRIDGE_TOOL_HANDOFF" }, executed: false }),
    { ...ended, data: { sessionID: "ses_fake", finish: "tool-calls" } },
  ]);
  assert.deepEqual(events.map((item) => item.type), ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
  const done = events.at(-1);
  if (done?.type !== "done") assert.fail("missing done");
  assert.equal(done.reason, "toolUse");
  assert.deepEqual(done.message.content, [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "fixture.txt" } }]);
});

test("native continuation guard completes only confirmed Pi tool handoffs", async () => {
  const start = event("session.tool.input.started", { id: "call_1", name: "read" });
  const called = event("session.tool.called", { id: "call_1", input: { path: "fixture.txt" }, executed: false });
  const blocked = event("session.tool.failed", { id: "call_1", error: { message: "PI_BRIDGE_TOOL_HANDOFF" } });
  for (const type of ["session.step.failed", "session.execution.failed"]) {
    const guard = event(type, { error: { message: "Pi owns continuation; stop the OpenCode loop" } });
    const result = await collect([start, called, blocked, guard]);
    const done = result.at(-1);
    if (done?.type !== "done") assert.fail("confirmed handoff must survive the continuation guard");
    assert.equal(done.reason, "toolUse");
    assert.deepEqual(done.message.content, [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "fixture.txt" } }]);
    assert.equal(result.filter((item) => item.type === "toolcall_end").length, 1);
    for (const prefix of [[], [start], [start, called], [start, blocked], [start, called, blocked, event("session.tool.input.started", { id: "call_2", name: "read" })], [event("session.text.delta", { ordinal: 0, delta: "Incomplete" })]]) {
      const failed = await collect([...prefix, guard]);
      assert.equal(failed.at(-1)?.type, "error");
      assert.equal(failed.some((item) => item.type === "toolcall_end" || item.type === "done"), false);
    }
    const failed = await collect([start, called, blocked, event(type, { error: { message: "upstream rate limit" } })]);
    assert.equal(failed.at(-1)?.type, "error", "real provider errors must not be swallowed");
  }
});

test("native transport fails closed on unknown/executed/unconfirmed tools, disconnects and reasoning-only turns", async () => {
  const start = event("session.tool.input.started", { id: "call_1", name: "read" });
  const called = event("session.tool.called", { id: "call_1", input: {} });
  for (const events of [
    [event("session.tool.input.started", { id: "call_1", name: "ffgrep" })],
    [start, called, ended],
    [start, event("session.tool.called", { id: "call_1", input: {}, executed: true })],
    [start, called, event("session.tool.failed", { id: "call_1", error: { message: "PI_BRIDGE_TOOL_HANDOFF" } }), event("session.tool.input.started", { id: "call_2", name: "read" }), event("session.step.ended", { finish: "tool-calls" })],
    [null],
    [event("session.text.delta", { ordinal: 0, delta: "Hello" }), event("session.text.ended", { ordinal: 0, text: "Changed" })],
    [start, called, event("session.tool.completed", { id: "call_1" }), ended],
    [start, called, event("session.tool.failed", { id: "call_1", error: { type: "unknown", message: "EACCES permission denied" } }), ended],
    [event("session.reasoning.delta", { ordinal: 0, delta: "I should call read." }), ended],
    [event("session.text.delta", { ordinal: 0, delta: "Incomplete" })],
    [event("session.step.failed", { error: { message: "upstream rate limit" } })],
  ]) {
    const result = await collect(events);
    assert.equal(result.at(-1)?.type, "error");
    assert.equal(result.some((item) => item.type === "done"), false);
    assert.equal(result.some((item) => item.type === "toolcall_end"), false);
  }
});

test("native transport denies permissions and ignores other sessions", async () => {
  await withServer([
    event("session.text.delta", { sessionID: "ses_other", ordinal: 0, delta: "wrong session" }),
    event("permission.asked", { id: "per_fake" }),
    event("session.text.delta", { ordinal: 0, delta: "OK" }), ended,
  ], async (options, dir) => {
    const message = await streamNativeOpenCode(model, context(), options).result();
    assert.deepEqual(message.content, [{ type: "text", text: "OK" }]);
    const requests = JSON.parse(readFileSync(join(dir, "requests.json"), "utf8"));
    assert.ok(requests.some((req: { path: string }) => req.path.endsWith("/permission/per_fake/reply")));
  });
});

test("native transport handles missing executables and cancellation before startup", async () => {
  const missing = await streamNativeOpenCode(model, context(), { env: { OPENCODE_NATIVE_PI_BIN: "/nonexistent/pi-opencode-server" }, timeoutMs: 1000 }).result();
  assert.equal(missing.stopReason, "error");
  assert.match(missing.errorMessage ?? "", /Could not start OpenCode/);
  const controller = new AbortController(); controller.abort();
  const aborted = await streamNativeOpenCode(model, context(), { signal: controller.signal }).result();
  assert.equal(aborted.stopReason, "aborted");
});

test("native transport aborts/times out and cleans up its private server", async () => {
  for (const shouldAbort of [true, false]) {
    await withServer([], async (options, dir) => {
      const controller = new AbortController();
      const stream = streamNativeOpenCode(model, context(), {
        ...options, timeoutMs: shouldAbort ? 5000 : 500, signal: controller.signal,
        onResponse: () => { if (shouldAbort) controller.abort(); },
      });
      const message = await stream.result();
      assert.equal(message.stopReason, shouldAbort ? "aborted" : "error");
      if (!shouldAbort) assert.match(message.errorMessage ?? "", /timed out/);
      const launch = JSON.parse(readFileSync(join(dir, "launch.json"), "utf8"));
      assert.equal(existsSync(launch.cwd), false);
    }, "// Keep the SSE response open until the adapter aborts.");
  }
});

test("native adapter plugin has no execution path and blocks OpenCode continuation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-plugin-test-"));
  const handlers = new Map<string, (event: unknown) => void>();
  const definitions: { execute: () => Promise<void> }[] = [];
  let disposed = 0;
  const registration = { async dispose() { disposed++; } };
  try {
    await mkdir(join(dir, "adapter"));
    await writeFile(join(dir, "turn.json"), JSON.stringify(buildNativeTurn(context(), true)));
    await writeFile(join(dir, "adapter", "index.mjs"), NATIVE_PLUGIN_SOURCE);
    const plugin = (await import(pathToFileURL(join(dir, "adapter", "index.mjs")).href)).default;
    const cleanup = await plugin.setup({
      tool: {
        async transform(callback: (draft: { add(tool: { execute: () => Promise<void> }): void }) => void) { callback({ add(tool) { definitions.push(tool); } }); return registration; },
        async hook(name: string, callback: (event: unknown) => void) { handlers.set(name, callback); return registration; },
      },
      session: { async hook(name: string, callback: (event: unknown) => void) { handlers.set(name, callback); return registration; } },
    });
    const request: { system: unknown[]; messages: { role: string; content: { type: string }[] }[]; tools: Record<string, unknown> } = { system: [], messages: [], tools: { read: { description: "internal" }, shell: {}, ffgrep: {} } };
    handlers.get("context")?.(request);
    assert.deepEqual(Object.keys(request.tools), ["read"]);
    assert.doesNotThrow(() => handlers.get("context")?.(request), "context retries before a handoff must remain safe");
    const historyLength = request.messages.length;
    request.messages.push({ role: "assistant", content: [{ type: "text" }] });
    handlers.get("context")?.(request);
    assert.equal(request.messages.length, historyLength, "native mutations must not alter the source transcript");
    assert.throws(() => handlers.get("execute.before")?.({ tool: "shell" }), /PI_BRIDGE_TOOL_HANDOFF/);
    await assert.rejects(definitions[0].execute(), /PI_BRIDGE_TOOL_HANDOFF/);
    assert.throws(() => handlers.get("context")?.(request), /Pi owns continuation/);
    await cleanup(); assert.equal(disposed, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
