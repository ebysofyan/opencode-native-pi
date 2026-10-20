import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { streamNativeOpenCode } from "./native.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";

const PROVIDER_ID = "opencode-cli";
const API_ID = "opencode-cli-runner";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DISCOVERY_TIMEOUT_MS = 8_000;
const STATUS_TIMEOUT_MS = 10_000;
const STDERR_LIMIT = 20_000;
export type CliStatus = {
  ok: boolean;
  summary: string;
  detail?: string;
};

const DEFAULT_FREE_MODELS = [
  "opencode/beam-free",
  "opencode/big-pickle",
  "opencode/deepseek-v4.1-flash-free",
  "opencode/glm-5.3-flash-free",
  "opencode/longcat-2.5-preview-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/minimax-m3.1-flash-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/nemotron-3.5-super-vl-free",
];
export type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ModelThinkingLevel[];

export type OpenCodeModelInfo = {
  id: string;
  name: string;
  reasoning: boolean;
  image: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
  /** True when `cost` was read from discovery metadata rather than defaulted. */
  costFromMetadata?: boolean;
  status?: string;
  thinkingLevelMap?: ThinkingLevelMap;
};

let registeredModels: OpenCodeModelInfo[] = [];
let lastDiscoveryTime: number | undefined;
let lastDiscoveryError: string | undefined;
let lastDiscoverySkipped: boolean | undefined;
let lastCliAvailable: boolean | undefined;

const OPENCODE_PANEL_STATUS = "Status (cached)";
const OPENCODE_PANEL_CONFIG = "Configuration (environment presence)";
const OPENCODE_PANEL_MODELS = "Models (cached)";
const OPENCODE_PANEL_BACK = "Back";
const OPENCODE_PANEL_CLOSE = "Close";

function panelEnvState(name: string): string {
  return process.env[name]?.trim() ? "set" : "default";
}

function cachedPanelState(value: boolean | undefined, positive: string, negative: string): string {
  if (value === undefined) return "not checked";
  return value ? positive : negative;
}

export async function showOpenCodePanelList(ctx: any, title: string, lines: string[]): Promise<"back" | "close"> {
  // Keep each ASCII detail to at most two selector rows at 40 columns.
  const records = (lines.length ? lines : ["No details available."]).flatMap((line) =>
    line ? Array.from({ length: Math.ceil(line.length / 40) }, (_, index) => line.slice(index * 40, (index + 1) * 40)) : [""],
  );
  let page = 0;
  while (true) {
    const detail = `• ${records[page]}`;
    const options = [
      detail,
      ...(page > 0 ? ["Previous"] : []),
      ...(page < records.length - 1 ? ["Next"] : []),
      OPENCODE_PANEL_BACK,
      OPENCODE_PANEL_CLOSE,
    ];
    const counter = ` (${page + 1}/${records.length})`;
    let heading = title;
    if (heading.length + counter.length > 38) heading = heading.replace(/\s+\([^()]*\)$/u, "");
    if (heading.length + counter.length > 38) heading = heading.slice(0, Math.min(30, 38 - counter.length));
    const choice = await ctx.ui.select(`${heading}${counter}`, options);
    if (choice === undefined || choice === OPENCODE_PANEL_CLOSE) return "close";
    if (choice === OPENCODE_PANEL_BACK) return "back";
    if (choice === "Previous" && page > 0) page -= 1;
    if (choice === "Next" && page < records.length - 1) page += 1;
  }
}

async function showOpenCodePanel(ctx: any): Promise<void> {
  while (true) {
    const choice = await ctx.ui.select("opencode-pi (read-only)", [
      OPENCODE_PANEL_STATUS,
      OPENCODE_PANEL_CONFIG,
      OPENCODE_PANEL_MODELS,
      OPENCODE_PANEL_CLOSE,
    ]);
    if (choice === undefined || choice === OPENCODE_PANEL_CLOSE) return;

    if (choice === OPENCODE_PANEL_STATUS) {
      const discovery = lastDiscoveryTime
        ? lastDiscoverySkipped
          ? "configured/skipped"
          : lastDiscoveryError === undefined
            ? "complete"
            : "fallback"
        : "not checked";
      const detail = await showOpenCodePanelList(ctx, "OpenCode CLI status (cached)", [
        `CLI: ${cachedPanelState(lastCliAvailable, "available", "unavailable")}`,
        `Model discovery: ${discovery}`,
        `Registered models: ${registeredModels.length}`,
      ]);
      if (detail === "close") return;
      continue;
    }

    if (choice === OPENCODE_PANEL_CONFIG) {
      const detail = await showOpenCodePanelList(ctx, "opencode-pi configuration (environment presence)", [
        `OPENCODE_PI_BIN: ${panelEnvState("OPENCODE_PI_BIN")}`,
        `OPENCODE_PI_MODELS: ${panelEnvState("OPENCODE_PI_MODELS")}`,
      ]);
      if (detail === "close") return;
      continue;
    }

    if (choice === OPENCODE_PANEL_MODELS) {
      const detail = await showOpenCodePanelList(ctx, "OpenCode models (cached)", [
        `Registered models: ${registeredModels.length}`,
        "IDs hidden to avoid exposing configured values",
      ]);
      if (detail === "close") return;
      continue;
    }

    return;
  }
}

function opencodeBin(): string {
  return process.env.OPENCODE_PI_BIN?.trim() || "opencode";
}

function configuredModels(): string[] | undefined {
  const raw = process.env.OPENCODE_PI_MODELS?.trim();
  if (!raw) return undefined;
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((model) => (model.includes("/") ? model : `opencode/${model}`));
}

function modelDisplayName(model: string): string {
  const [, id = model] = model.split(/\/(.*)/s);
  return `OpenCode ${id}`;
}

function contextWindowFor(model: string): number {
  if (model.includes("big-pickle")) return 200_000;
  return DEFAULT_CONTEXT_WINDOW;
}

function maxTokensFor(model: string): number {
  if (model.includes("big-pickle")) return 32_000;
  return DEFAULT_MAX_TOKENS;
}

function looksFree(model: string): boolean {
  return /(^opencode\/.*-free$)|(^opencode\/big-pickle$)/.test(model);
}

/** Read a non-negative finite cost figure; anything else means "unknown". */
function costFigure(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Accept the model catalog cost entries and object-shaped metadata. */
function costEntry(cost: unknown): {
  input?: unknown;
  output?: unknown;
  cache?: { read?: unknown; write?: unknown };
} {
  const value = Array.isArray(cost) ? cost[0] : cost;
  return typeof value === "object" && value !== null
    ? (value as {
        input?: unknown;
        output?: unknown;
        cache?: { read?: unknown; write?: unknown };
      })
    : {};
}

/**
 * Read the real per-model cost from discovery metadata (#78).
 * Missing or malformed figures fall back to zero so a model is never
 * reported with an invented non-zero cost.
 */
export function parseModelCost(metadata: unknown): ModelCost {
  const cost = costEntry((metadata as { cost?: unknown } | null)?.cost);
  return {
    input: costFigure(cost.input) ?? 0,
    output: costFigure(cost.output) ?? 0,
    cacheRead: costFigure(cost.cache?.read) ?? 0,
    cacheWrite: costFigure(cost.cache?.write) ?? 0,
  };
}

/**
 * Free models are identified by zero input and output cost in the discovery
 * metadata (#77). When a record carries no usable cost figures (older CLI
 * output), fall back to the legacy `-free` name pattern so paid models are
 * never misregistered as free.
 */
export function isFreeModel(model: {
  id: string;
  cost: ModelCost;
  costFromMetadata?: boolean;
}): boolean {
  if (model.cost.input !== 0 || model.cost.output !== 0) return false;
  if (model.costFromMetadata === true) return true;
  return looksFree(model.id);
}

/**
 * Discovery metadata carries a per-model status field (#79). Only `active`
 * models are registered; a missing status is treated as active so older CLI
 * output without the field keeps working.
 */
export function isActiveModel(status: unknown): boolean {
  if (status === undefined || status === null) return true;
  return String(status).trim().toLowerCase() === "active";
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function fallbackModel(id: string): OpenCodeModelInfo {
  return {
    id,
    name: modelDisplayName(id),
    reasoning: false,
    image: false,
    contextWindow: contextWindowFor(id),
    maxTokens: maxTokensFor(id),
    cost: ZERO_COST,
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/** Read catalog input modalities. */
function supportsImage(input: unknown): boolean {
  if (Array.isArray(input)) return input.includes("image");
  return (input as { image?: unknown } | null | undefined)?.image === true;
}

/** v2 dropped `capabilities.reasoning`; reasoning shows up as effort variants. */
function hasReasoningVariant(variants: unknown): boolean {
  if (!Array.isArray(variants)) return false;
  return variants.some((variant) => {
    const settings = (variant as { settings?: Record<string, unknown> } | null)
      ?.settings;
    return (
      settings?.reasoningEffort !== undefined || settings?.reasoning !== undefined
    );
  });
}

function variantNames(variants: unknown): Set<string> {
  if (Array.isArray(variants)) {
    return new Set(
      variants.flatMap((variant) => {
        const id = (variant as { id?: unknown } | null)?.id;
        return typeof id === "string" ? [id] : [];
      }),
    );
  }
  return typeof variants === "object" && variants !== null
    ? new Set(Object.keys(variants))
    : new Set<string>();
}

function thinkingLevelMap(variants: unknown): ThinkingLevelMap {
  const map: ThinkingLevelMap = {};
  const names = variantNames(variants);

  for (const level of THINKING_LEVELS) {
    if (level === "off") {
      if (names.has("off")) map.off = "off";
      else if (names.has("none")) map.off = "none";
      continue;
    }
    map[level] = names.has(level) ? level : null;
  }
  if (!names.has("xhigh") && names.has("max")) map.xhigh = "max";
  return map;
}

type DiscoveryMetadata = {
  name?: unknown;
  status?: unknown;
  cost?: unknown;
  limit?: { context?: unknown; output?: unknown };
  capabilities?: { reasoning?: unknown; input?: unknown };
  variants?: unknown;
};

/** Map one catalog record to registered model metadata. */
function modelInfoFromMetadata(
  id: string,
  value: DiscoveryMetadata,
): OpenCodeModelInfo {
  const cost = parseModelCost(value);
  const entry = costEntry(value.cost);
  const costFromMetadata =
    costFigure(entry.input) !== undefined && costFigure(entry.output) !== undefined;
  const reasoning =
    value.capabilities?.reasoning === true || hasReasoningVariant(value.variants);
  const status =
    typeof value.status === "string" && value.status.trim()
      ? value.status.trim()
      : undefined;
  return {
    id,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : modelDisplayName(id),
    reasoning,
    image: supportsImage(value.capabilities?.input),
    contextWindow: positiveNumber(value.limit?.context, contextWindowFor(id)),
    maxTokens: positiveNumber(value.limit?.output, maxTokensFor(id)),
    cost,
    ...(costFromMetadata ? { costFromMetadata: true as const } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(reasoning ? { thinkingLevelMap: thinkingLevelMap(value.variants) } : {}),
  };
}

/**
 * Parse the `opencode api GET /api/model` payload from OpenCode v2, which
 * replaced `opencode models <provider> --verbose` with an HTTP API.
 * shortcut: only the `opencode` provider is read; extend when the
 * extension learns to serve other providers.
 */
export function parseApiModels(output: string): OpenCodeModelInfo[] {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return [];
  }
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const records: OpenCodeModelInfo[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as DiscoveryMetadata & {
      providerID?: unknown;
      modelID?: unknown;
    };
    if (value.providerID !== "opencode" || typeof value.modelID !== "string") {
      continue;
    }
    const model = value.modelID;
    const id = model.startsWith("opencode/")
      ? model
      : `opencode/${model}`;
    records.push(modelInfoFromMetadata(id, value));
  }
  return records;
}

function runCapture(
  args: string[],
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  bin = opencodeBin(),
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`opencode timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

  });
}

/** Run a capture command and return stdout, throwing on a non-zero exit. */
async function captureOk(args: string[]): Promise<string> {
  const result = await runCapture(args);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `opencode ${args.join(" ")} exited with code ${result.code}`,
    );
  }
  return result.stdout;
}

/** Build the install/setup instructions shown when the opencode CLI is unusable. */
export function setupGuidance(error: string): string {
  return [
    "opencode-pi could not use the local OpenCode CLI.",
    `Reason: ${error}`,
    "Install OpenCode (https://opencode.ai), ensure `opencode --version` works on PATH, then reload Pi.",
    "Set OPENCODE_PI_BIN to override the executable path.",
  ].join(" ");
}

let checkedCli: { bin: string; result: Promise<CliStatus> } | undefined;

/** Reuse one version probe across startup and turns; retry failed probes. */
export function checkCliStatus(bin = opencodeBin()): Promise<CliStatus> {
  if (checkedCli?.bin === bin) return checkedCli.result;
  const result = (async (): Promise<CliStatus> => {
    try {
      const result = await runCapture(["--version"], STATUS_TIMEOUT_MS, bin);
      const version = result.stdout.trim() || result.stderr.trim();
      const match = version.match(/^(?:opencode\s+)?v?(\d+)\.(\d+)\.\d+(?:[-+][\w.-]+)?$/i);
      if (result.code !== 0 || !match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 1)) {
        return { ok: false, summary: "OpenCode 2.1+ is required", detail: "Requires OpenCode 2.1+; install or upgrade from https://opencode.ai." };
      }
      return { ok: true, summary: version };
    } catch (error) {
      return { ok: false, summary: "OpenCode CLI is unavailable", detail: error instanceof Error ? error.message : String(error) };
    }
  })();
  checkedCli = { bin, result };
  void result.then((status) => { if (!status.ok && checkedCli?.result === result) checkedCli = undefined; });
  return result;
}

export async function discoverModels(opts?: {
  forceDiscovery?: boolean;
}): Promise<{
  models: OpenCodeModelInfo[];
  time: number;
  error: string | undefined;
}> {
  const configured = configuredModels();
  lastDiscoverySkipped = Boolean(configured?.length && !opts?.forceDiscovery);
  // An explicit OPENCODE_PI_MODELS list already tells us exactly which
  // models to register, so the fast (non-forced) path skips spawning
  // opencode entirely rather than making explicitly configured users pay a
  // discovery timeout on every startup when the binary is missing or slow.
  // `forceDiscovery` (used by the user-initiated /opencode-pi update
  // command) still runs discovery so configured models can be enriched with
  // real capability metadata (reasoning/image/limits) on request.
  if (configured?.length && !opts?.forceDiscovery) {
    lastDiscoveryError = undefined;
    return {
      models: dedupe(configured).map(fallbackModel),
      time: Date.now(),
      error: undefined,
    };
  }

  try {
    const status = await checkCliStatus();
    if (!status.ok) throw new Error(status.detail ?? status.summary);
    const args = ["api", "GET", "/api/model"];
    let metadata = parseApiModels(await captureOk(args));
    if (!metadata.length) {
      // A cold service can return no models while its catalog warms up.
      await new Promise((resolve) => setTimeout(resolve, 400));
      metadata = parseApiModels(await captureOk(args));
    }
    const byId = new Map(metadata.map((model) => [model.id, model]));
    const selected = configured?.length
      ? dedupe(configured).map((id) => byId.get(id) ?? fallbackModel(id))
      : metadata.filter((model) => isActiveModel(model.status) && isFreeModel(model));
    if (!selected.length) throw new Error("discovery returned no free models");
    lastDiscoveryError = undefined;
    return { models: selected, time: Date.now(), error: undefined };
  } catch (error) {
    lastDiscoveryError = error instanceof Error ? error.message : String(error);
  }
  const fallbackIds = configured?.length
    ? dedupe(configured)
    : DEFAULT_FREE_MODELS;
  return {
    models: fallbackIds.map(fallbackModel),
    time: Date.now(),
    error: lastDiscoveryError,
  };
}

async function refreshModels(
  pi: ExtensionAPI,
  ctx: { ui: { notify: (msg: string, level?: string) => void } },
): Promise<void> {
  const previousModels = new Set(registeredModels.map((model) => model.id));
  const { models, time, error } = await discoverModels({
    forceDiscovery: true,
  });
  registeredModels = models;
  lastDiscoveryTime = time;

  // Re-register the provider with the updated model list
  const providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] = {
    name: "OpenCode CLI",
    baseUrl: "cli:opencode",
    apiKey: "opencode-cli-no-api-key",
    api: API_ID,
    models: models.map(providerModel),
    streamSimple: streamOpenCode,
  };

  try {
    pi.registerProvider(PROVIDER_ID, providerConfig);
  } catch {
    // registerProvider may reject if already registered; the models array is already updated.
  }

  const newModels = models.filter((model) => !previousModels.has(model.id));

  let msg = `opencode-pi: refreshed ${models.length} model(s).`;
  if (newModels.length > 0) {
    msg += ` ${newModels.length} new: ${newModels
      .slice(0, 5)
      .map((model) => model.id)
      .join(", ")}${newModels.length > 5 ? ", ..." : ""}`;
  }
  if (error) msg += ` Discovery issue: ${error}`;
  ctx.ui.notify(msg, "info");
}

export function streamOpenCode(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    try {
      options?.signal?.throwIfAborted();
      const status = await checkCliStatus(options?.env?.OPENCODE_PI_BIN?.trim() || opencodeBin());
      options?.signal?.throwIfAborted();
      if (!status.ok) throw new Error(status.detail ?? status.summary);
      const source = streamNativeOpenCode(model, context, options);
      for await (const event of source) stream.push(event);
    } catch (error) {
      const output: AssistantMessage = {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(), stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      stream.push({ type: "error", reason: output.stopReason as "error" | "aborted", error: output });
    } finally {
      stream.end();
    }
  })();
  return stream;
}

function providerModel(model: OpenCodeModelInfo) {
  return {
    id: model.id,
    name: `${model.name} (OpenCode CLI)`,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap
      ? { thinkingLevelMap: model.thinkingLevelMap }
      : {}),
    input: model.image
      ? (["text", "image"] as ("text" | "image")[])
      : (["text"] as ("text" | "image")[]),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
  };
}

function statusLines(): string[] {
  const lines = [
    `Provider: ${PROVIDER_ID}`,
    `OpenCode binary: ${opencodeBin()}`,
    `OpenCode installed: ${existsSync(opencodeBin()) || opencodeBin() === "opencode" ? "check PATH with /opencode-pi test" : "no"}`,
    `Registered models: ${registeredModels.length}`,
    `Last discovery: ${lastDiscoveryTime ? new Date(lastDiscoveryTime).toLocaleString() : "never"}`,
  ];
  if (lastDiscoveryError)
    lines.push(`Discovery fallback: ${lastDiscoveryError}`);
  lines.push("");
  for (const model of registeredModels) {
    const capabilities = [
      model.reasoning ? "reasoning" : undefined,
      model.image ? "image" : undefined,
    ].filter(Boolean);
    lines.push(
      `  - ${PROVIDER_ID}/${model.id}${capabilities.length > 0 ? ` (${capabilities.join(", ")})` : ""}`,
    );
  }
  lines.push("");
  lines.push(
    "OpenCode login is not required for the bundled free OpenCode models.",
  );
  lines.push(
    "Requires OpenCode 2.1+; native streaming with Pi-owned tool execution.",
  );
  lines.push(
    "Run /opencode-pi update to refresh the model list from opencode.",
  );
  return lines;
}

export default async function opencodePiExtension(pi: ExtensionAPI) {
  const { models, time } = await discoverModels();
  registeredModels = models;
  lastDiscoveryTime = time;

  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode CLI",
    baseUrl: "cli:opencode",
    apiKey: "opencode-cli-no-api-key",
    api: API_ID,
    models: registeredModels.map(providerModel),
    streamSimple: streamOpenCode,
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    const cliStatus = await checkCliStatus();
    lastCliAvailable = cliStatus.ok;
    if (!cliStatus.ok) {
      const fastPathConfigured = Boolean(configuredModels()?.length);
      const fastPathNote = fastPathConfigured
        ? "OPENCODE_PI_MODELS skipped discovery, so this was not detected at startup. "
        : "";
      ctx.ui.notify(
        `opencode-pi: ${fastPathNote}${setupGuidance(cliStatus.detail ?? cliStatus.summary)}`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      `opencode-pi: registered ${registeredModels.length} OpenCode CLI model(s). Use /model and pick ${PROVIDER_ID}.`,
      "info",
    );
    if (lastDiscoveryError) {
      ctx.ui.notify(
        `opencode-pi: model discovery used fallback (${lastDiscoveryError})`,
        "warning",
      );
    }
  });

  pi.registerCommand("opencode-pi", {
    description: "OpenCode CLI bridge status and setup help",
    handler: async (args: string, ctx: any) => {
      const trimmedArgs = args.trim();
      if (trimmedArgs.length === 0 && ctx.mode === "tui" && ctx.hasUI) {
        await showOpenCodePanel(ctx);
        return;
      }

      const sub = trimmedArgs.split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "status") {
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "models") {
        for (const model of registeredModels)
          ctx.ui.notify(`${PROVIDER_ID}/${model.id}`, "info");
        ctx.ui.notify(
          `Override with OPENCODE_PI_MODELS="opencode/model-a,opencode/model-b"`,
          "info",
        );
        return;
      }
      if (sub === "test") {
        ctx.ui.notify(
          `Run: pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0]?.id ?? DEFAULT_FREE_MODELS[0]} "Reply with exactly OK"`,
          "info",
        );
        ctx.ui.notify(
          `OpenCode check: ${opencodeBin()} --version (requires 2.1+)`,
          "info",
        );
        return;
      }
      if (sub === "update") {
        await refreshModels(pi, ctx);
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "help") {
        ctx.ui.notify(
          "Usage: /opencode-pi [status|models|test|update|help]",
          "info",
        );
        ctx.ui.notify(
          "Set OPENCODE_PI_BIN to override the opencode executable.",
          "info",
        );
        ctx.ui.notify(
          "Set OPENCODE_PI_MODELS to register a custom comma-separated model list.",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `Unknown /opencode-pi subcommand: ${sub}. Try /opencode-pi help`,
        "warning",
      );
    },
  });
}
