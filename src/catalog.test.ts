import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkCliStatus, discoverModels, parseApiModels, streamOpenCode } from "./index.js";
import extension from "./index.js";
import type { Api, Model } from "@earendil-works/pi-ai";

const catalog = { data: [
  { providerID: "opencode", modelID: "active-free", status: "active", cost: [{ input: 0, output: 0 }], capabilities: { input: ["text", "image"] }, variants: [{ id: "high", settings: { reasoningEffort: "high" } }] },
  { providerID: "opencode", modelID: "paid", cost: [{ input: 1, output: 2 }] },
  { providerID: "opencode", modelID: "retired-free", status: "retired", cost: [{ input: 0, output: 0 }] },
] };
const model: Model<Api> = { id: "opencode/fake-free", name: "Fake", api: "opencode-cli-runner", provider: "opencode-cli", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };

async function withCli(run: (log: () => string[]) => Promise<void>, version = "opencode v2.1.0", cold = false, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-catalog-"));
  const bin = join(dir, "opencode.cjs");
  const log = join(dir, "calls.log");
  const previousBin = process.env.OPENCODE_NATIVE_PI_BIN;
  const previousModels = process.env.OPENCODE_NATIVE_PI_MODELS;
  writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)},args+'\\n');
if(args==='--version'){console.log(${JSON.stringify(version)});process.exit(0);}
if(args==='api GET /api/model'){
 if(${fail}){console.error('catalog unavailable');process.exit(1);}
 const calls=fs.readFileSync(${JSON.stringify(log)},'utf8').split('\\n').filter(x=>x===args).length;
 console.log(JSON.stringify(${cold}&&calls===1?{data:[]}:${JSON.stringify(catalog)}));process.exit(0);
}
console.error('unexpected CLI call');process.exit(1);
`);
  chmodSync(bin, 0o755);
  process.env.OPENCODE_NATIVE_PI_BIN = bin;
  delete process.env.OPENCODE_NATIVE_PI_MODELS;
  try { await run(() => readFileSync(log, "utf8").trim().split("\n")); }
  finally {
    for (const [key, value] of [["OPENCODE_NATIVE_PI_BIN", previousBin], ["OPENCODE_NATIVE_PI_MODELS", previousModels]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("version probe is shared across concurrent checks and discovery", async () => {
  await withCli(async (log) => {
    const checks = await Promise.all([checkCliStatus(), checkCliStatus()]);
    assert.ok(checks.every((check) => check.ok));
    const result = await discoverModels();
    assert.equal(result.error, undefined);
    assert.deepEqual(result.models.map((item) => item.id), ["opencode/active-free"]);
    assert.equal(result.models[0]?.image, true);
    assert.equal(result.models[0]?.reasoning, true);
    assert.deepEqual(log(), ["--version", "api GET /api/model"]);
  });
});

test("old, unknown and unsupported versions fail before native transport starts", async () => {
  for (const version of ["opencode v1.9.0", "opencode v2.0.9", "garbage"]) {
    await withCli(async (log) => {
      assert.equal((await checkCliStatus()).ok, false);
      const result = await streamOpenCode(model, { messages: [] }).result();
      assert.equal(result.stopReason, "error");
      assert.match(result.errorMessage ?? "", /2\.1\+/);
      assert.ok(log().every((call) => call === "--version"));
    }, version);
  }
});

test("failed probes retry after an executable is repaired at the same path", async () => {
  await withCli(async () => {
    assert.equal((await checkCliStatus()).ok, false);
    writeFileSync(process.env.OPENCODE_NATIVE_PI_BIN!, '#!/usr/bin/env node\nconsole.log("opencode v2.1.0");\n');
    assert.equal((await checkCliStatus()).ok, true);
  }, "broken");
});

test("configured catalog skips discovery, explicit refresh enriches paid models", async () => {
  await withCli(async (log) => {
    process.env.OPENCODE_NATIVE_PI_MODELS = "paid,paid,custom-free";
    const fallback = await discoverModels();
    assert.deepEqual(fallback.models.map((item) => item.id), ["opencode/paid", "opencode/custom-free"]);
    assert.equal(fallback.models[0]?.reasoning, false);
    const enriched = await discoverModels({ forceDiscovery: true });
    assert.equal(enriched.models[0]?.cost.input, 1);
    assert.equal(enriched.models[1]?.id, "opencode/custom-free");
    assert.deepEqual(log(), ["--version", "api GET /api/model"]);
  });
});

test("cold catalog retries once; failures use conservative fallback without v1 calls", async () => {
  await withCli(async (log) => {
    assert.equal((await discoverModels()).error, undefined);
    assert.equal(log().filter((call) => call === "api GET /api/model").length, 2);
  }, undefined, true);
  await withCli(async (log) => {
    const result = await discoverModels();
    assert.match(result.error ?? "", /catalog unavailable/);
    assert.ok(result.models.length > 0);
    assert.ok(result.models.every((item) => !item.reasoning && !item.image));
    assert.deepEqual(log(), ["--version", "api GET /api/model"]);
  }, undefined, false, true);
});

test("malformed catalogs do not produce model metadata", () => {
  for (const payload of ["invalid", "null", "{}", '{"data":{}}', '{"data":[null,{},1]}']) assert.deepEqual(parseApiModels(payload), []);
});

test("registration preserves capabilities and startup reuses the discovery probe", async () => {
  await withCli(async (log) => {
    let config: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
    let startup: (() => Promise<void>) | undefined;
    const notices: string[] = [];
    const pi = {
      registerProvider(_id: string, value: typeof config) { config = value; },
      registerCommand() {},
      on(name: string, callback: (event: unknown, ctx: unknown) => Promise<void>) {
        if (name === "session_start") startup = () => callback({}, { ui: { notify(message: string) { notices.push(message); } } });
      },
    } as unknown as ExtensionAPI;
    await extension(pi);
    await startup?.();
    assert.equal(config?.streamSimple, streamOpenCode);
    assert.deepEqual(config?.models?.[0]?.input, ["text", "image"]);
    assert.ok(notices.some((message) => message.includes("registered")));
    assert.equal(log().filter((call) => call === "--version").length, 1);
  });
});

test("aborted turns do not probe or start OpenCode", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await streamOpenCode(model, { messages: [] }, { signal: controller.signal }).result();
  assert.equal(result.stopReason, "aborted");
});
