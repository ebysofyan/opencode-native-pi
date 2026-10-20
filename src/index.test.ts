import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import opencodePiExtension, { isActiveModel, isFreeModel, parseApiModels, parseModelCost, showOpenCodePanelList } from "./index.js";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("parseModelCost reads real input, output, and cache figures", () => {
  assert.deepEqual(
    parseModelCost({
      cost: { input: 10, output: 50, cache: { read: 1, write: 12.5 } },
    }),
    { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  );
});

test("parseModelCost defaults missing or malformed figures to zero", () => {
  assert.deepEqual(parseModelCost({}), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(
    parseModelCost({
      cost: { input: -5, output: "free", cache: { read: NaN, write: null } },
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
});

test("isFreeModel selects by cost metadata, not the name pattern", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // A free model without a -free suffix is picked up via cost metadata.
  assert.equal(
    isFreeModel({ id: "opencode/big-pickle", cost: zero, costFromMetadata: true }),
    true,
  );
  // A paid model keeps its real cost even with a -free-looking name.
  assert.equal(
    isFreeModel({
      id: "opencode/sneaky-free",
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      costFromMetadata: true,
    }),
    false,
  );
  // Without cost metadata the legacy name pattern still applies.
  assert.equal(isFreeModel({ id: "opencode/old-free", cost: zero }), true);
  assert.equal(isFreeModel({ id: "opencode/old-paid", cost: zero }), false);
});

test("isActiveModel excludes non-active statuses and tolerates a missing field", () => {
  assert.equal(isActiveModel("active"), true);
  assert.equal(isActiveModel("Active"), true);
  assert.equal(isActiveModel("deprecated"), false);
  assert.equal(isActiveModel("disabled"), false);
  assert.equal(isActiveModel(undefined), true);
  assert.equal(isActiveModel(null), true);
});

test("parseApiModels reads the v2 /api/model payload for the opencode provider", () => {
  const models = parseApiModels(
    JSON.stringify({
      location: { directory: "/tmp" },
      data: [
        {
          id: "space-bunny-free",
          modelID: "space-bunny-free",
          providerID: "opencode",
          name: "Space Bunny Free",
          capabilities: { input: ["text", "image"] },
          variants: [
            { id: "low", settings: { reasoningEffort: "low" } },
            { id: "max", settings: { reasoningEffort: "max" } },
          ],
          cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
          status: "active",
          limit: { context: 1_048_576, output: 524_288 },
        },
        {
          id: "paid",
          modelID: "paid",
          providerID: "opencode",
          capabilities: { input: ["text"] },
          cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 0 } }],
          status: "active",
        },
        { modelID: "gpt-astra-latest", providerID: "openrouter", cost: [] },
        { modelID: "broken" },
      ],
    }),
  );

  assert.deepEqual(
    models.map((model) => model.id),
    ["opencode/space-bunny-free", "opencode/paid"],
  );
  const free = models[0];
  assert.equal(free?.name, "Space Bunny Free");
  assert.equal(free?.image, true);
  assert.equal(free?.reasoning, true);
  assert.equal(free?.contextWindow, 1_048_576);
  assert.equal(free?.maxTokens, 524_288);
  assert.equal(free?.costFromMetadata, true);
  assert.deepEqual(free?.thinkingLevelMap, {
    minimal: null,
    low: "low",
    medium: null,
    high: null,
    xhigh: "max",
  });
  assert.equal(isFreeModel(free!), true);
  assert.equal(isFreeModel(models[1]!), false);
  assert.deepEqual(models[1]?.cost, {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 0,
  });
});

test("detail pagination bounds options, traverses duplicates, and preserves exits", async () => {
  const records = ["Back", "Next", "Close", "Previous", "Back"];
  const actions = ["detail", ...Array.from({ length: 4 }, () => ["Next", "detail"]).flat(), "Next", ...Array(4).fill("Previous"), "Previous", "Back"];
  const pages: number[] = [];
  const result = await showOpenCodePanelList({ ui: { select: async (title: string, options: string[]) => {
    assert.ok(pages.length < actions.length);
    const previous = pages.at(-1) ?? 1;
    const action = actions[pages.length - 1];
    const page = pages.length === 0 ? 1 : action === "Next" ? Math.min(5, previous + 1) : action === "Previous" ? Math.max(1, previous - 1) : previous;
    pages.push(page);
    assert.equal(title, `Details (${page}/5)`);
    assert.deepEqual(options, [`• ${records[page - 1]}`, ...(page > 1 ? ["Previous"] : []), ...(page < 5 ? ["Next"] : []), "Back", "Close"]);
    assert.ok(options.length <= 5);
    return actions[pages.length - 1] === "detail" ? options[0] : actions[pages.length - 1];
  } } }, "Details", records);
  assert.equal(result, "back");
  assert.deepEqual(pages, [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 4, 3, 2, 1, 1]);
  for (const [lines, answer, detail, outcome] of [
    [[], "Back", "No details available.", "back"],
    [["Close"], "Close", "Close", "close"],
    [["Previous"], undefined, "Previous", "close"],
  ] as [string[], string | undefined, string, string][]) {
    let calls = 0;
    assert.equal(await showOpenCodePanelList({ ui: { select: async (title: string, options: string[]) => {
      calls++;
      assert.equal(title, "Details (1/1)");
      assert.deepEqual(options, [`• ${detail}`, "Back", "Close"]);
      return answer;
    } } }, "Details", lines), outcome);
    assert.equal(calls, 1);
  }
});

test("long ASCII details retain every character in order with short titles and bounded options", async () => {
  const records = ["Back", "Credentials: managed externally by OpenCode CLI (contents not read)", "Next", "z".repeat(91), "Close"];
  const segments: string[] = [];
  await showOpenCodePanelList({ ui: { select: async (title: string, options: string[]) => {
    assert.ok(title.length <= 38);
    assert.ok(title.startsWith("opencode-pi configuration ("));
    assert.ok(options.length <= 5);
    assert.ok(options[0]?.startsWith("• "));
    segments.push(options[0]!.slice(2));
    assert.ok(options[0]!.slice(2).length <= 40);
    return options.includes("Next") ? "Next" : "Back";
  } } }, "opencode-pi configuration (environment presence)", records);
  assert.equal(segments.join(""), records.join(""));
  assert.deepEqual(segments.slice(0, 2), ["Back", records[1]!.slice(0, 40)]);
  await showOpenCodePanelList({ ui: { select: async (title: string) => {
    assert.equal(title, `${"X".repeat(30)} (1/1)`);
    return undefined;
  } } }, "X".repeat(80), ["ok"]);
});

function panelOpenCodeCommand() {
  type PanelCommand = {
    handler: (args: string, ctx: unknown) => Promise<void>;
  };
  let command: PanelCommand | undefined;
  return {
    extension: {
      registerProvider() {},
      on() {},
      registerCommand(name: string, registered: unknown) {
        if (name === "opencode-pi") command = registered as PanelCommand;
      },
    } as unknown as ExtensionAPI,
    get command(): PanelCommand {
      if (!command) throw new Error("opencode-pi command was not registered");
      return command;
    },
  };
}

test("bare opencode-pi uses a cancellable read-only panel without discovery or CLI calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-panel-"));
  const marker = join(dir, "cli-invoked");
  const binPath = join(dir, "opencode-panel.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");\nprocess.stdout.write("opencode v1.0.0");\n`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  const previousBin = process.env.OPENCODE_PI_BIN;
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_BIN = binPath;
  const modelIds = [
    "auto",
    "composer-2.5",
    "opencode/alice.smith",
    "Users/alice/project",
    "fake-model-key",
    "provider/fake-model-key/model",
    "fake-github-token",
    "my-secret-token",
    "bearer-abcdefghijklmnopqrstuvwxyz0123456789",
    "https://user:password@example.test/token",
    "user@example.test",
    "token_0123456789abcdef",
  ];
  const secretValues = [
    ...modelIds,
    binPath,
  ];
  process.env.OPENCODE_PI_MODELS = modelIds.join(",");

  try {
    const captured = panelOpenCodeCommand();
    await opencodePiExtension(captured.extension);
    const selections: { title: string; options: string[] }[] = [];
    const choices = ["Status (cached)", "Close"];
    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title: string, options: string[]) {
          selections.push({ title, options });
          return title !== "opencode-pi (read-only)" && options.includes("Next") ? "Next" : choices.shift();
        },
        notify() {
          throw new Error("the read-only panel must not notify");
        },
      },
    });

    assert.ok(selections.length >= 4);
    assert.ok(selections[0]!.options.includes("Close"));
    assert.equal(existsSync(marker), false);
    const statusPanelText = JSON.stringify(selections);
    const detailText = selections.map(({ options }) => options[0]?.startsWith("• ") ? options[0].slice(2) : "").join("");
    assert.match(detailText, /Model discovery: configured\/skipped/);
    assert.match(statusPanelText, new RegExp(`Registered models: ${modelIds.length}`));
    for (const modelId of modelIds) assert.equal(statusPanelText.includes(modelId), false);
    for (const secret of secretValues) assert.equal(statusPanelText.includes(secret), false);

    const configSelections: { title: string; options: string[] }[] = [];
    const configChoices = ["Configuration (environment presence)", "Close"];
    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title: string, options: string[]) {
          configSelections.push({ title, options });
          return title !== "opencode-pi (read-only)" && options.includes("Next") ? "Next" : configChoices.shift();
        },
      },
    });
    const configPanelText = JSON.stringify(configSelections);
    assert.match(configPanelText, /OPENCODE_PI_BIN: set/);
    assert.match(configPanelText, /OPENCODE_PI_MODELS: set/);
    for (const secret of secretValues) assert.equal(configPanelText.includes(secret), false);
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-pi panel hides configured model IDs, supports cancellation, and preserves non-TUI fallback", async () => {
  const previousBin = process.env.OPENCODE_PI_BIN;
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_BIN = "/tmp/opencode-panel-secret-bin";
  const modelIds = [
    "auto",
    "composer-2.5",
    "opencode/alice.smith",
    "Users/alice/project",
    "fake-model-key",
    "provider/fake-model-key/model",
    "fake-github-token",
    "my-secret-token",
    "bearer-abcdefghijklmnopqrstuvwxyz0123456789",
    "https://user:password@example.test/token",
    "user@example.test",
    "token_0123456789abcdef",
  ];
  process.env.OPENCODE_PI_MODELS = modelIds.join(",");

  try {
    const captured = panelOpenCodeCommand();
    await opencodePiExtension(captured.extension);

    let calls = 0;
    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select() {
          calls += 1;
          return undefined;
        },
        notify() {
          throw new Error("cancelled panel must not notify");
        },
      },
    });
    assert.equal(calls, 1);

    const selections: { title: string; options: string[] }[] = [];
    const choices = ["Models (cached)", "Close"];
    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title: string, options: string[]) {
          selections.push({ title, options });
          return title !== "opencode-pi (read-only)" && options.includes("Next") ? "Next" : choices.shift();
        },
      },
    });
    const panelText = JSON.stringify(selections);
    assert.match(panelText, new RegExp(`Registered models: ${modelIds.length}`));
    assert.match(selections.map(({ options }) => options[0]?.startsWith("• ") ? options[0].slice(2) : "").join(""), /IDs hidden to avoid exposing configured values/);
    for (const modelId of modelIds) assert.equal(panelText.includes(modelId), false);

    const explicitNotifications: string[] = [];
    let explicitSelectCalls = 0;
    await captured.command.handler("help", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select() {
          explicitSelectCalls += 1;
          throw new Error("explicit subcommands must not open the panel");
        },
        notify(message: string) {
          explicitNotifications.push(message);
        },
      },
    });
    assert.equal(explicitSelectCalls, 0);
    assert.ok(explicitNotifications.some((message) => message.includes("Usage: /opencode-pi")));

    const notifications: string[] = [];
    calls = 0;
    for (const mode of ["tui", "print"]) {
      await captured.command.handler("", {
        mode,
        hasUI: false,
        ui: {
          async select() {
            calls += 1;
            throw new Error("a context without UI must not select");
          },
          notify(message: string) {
            notifications.push(message);
          },
        },
      });
    }
    assert.equal(calls, 0);
    assert.ok(notifications.length > 0);
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("opencode-pi keeps informational rows in detail and supports Back, another section, Close, and Escape", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_MODELS = "custom-panel-model";

  try {
    const captured = panelOpenCodeCommand();
    await opencodePiExtension(captured.extension);
    const selections: { title: string; options: string[] }[] = [];
    const topChoices = ["Status (cached)", "Configuration (environment presence)"];
    let statusDetailVisits = 0;

    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title: string, options: string[]) {
          selections.push({ title, options });
          if (title === "opencode-pi (read-only)") return topChoices.shift();
          if (title.startsWith("OpenCode CLI status (cached) (")) {
            if (statusDetailVisits++ === 0) return options[0];
            return "Back";
          }
          if (title.startsWith("opencode-pi configuration (")) return "Close";
          throw new Error(`unexpected panel ${title}`);
        },
      },
    });

    assert.deepEqual(selections.map(({ title }) => title), [
      "opencode-pi (read-only)",
      "OpenCode CLI status (cached) (1/3)",
      "OpenCode CLI status (cached) (1/3)",
      "opencode-pi (read-only)",
      "opencode-pi configuration (1/2)",
    ]);
    assert.ok(selections[1]!.options.includes("Back"));
    assert.ok(selections[1]!.options.includes("Close"));
    assert.ok(selections[2]!.options.includes("Back"));
    assert.ok(selections[4]!.options.includes("Back"));
    assert.ok(selections[4]!.options.includes("Close"));

    const escapedSelections: { title: string; options: string[] }[] = [];
    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title: string, options: string[]) {
          escapedSelections.push({ title, options });
          return title === "opencode-pi (read-only)" ? "Models (cached)" : undefined;
        },
      },
    });
    assert.deepEqual(escapedSelections.map(({ title }) => title), [
      "opencode-pi (read-only)",
      "OpenCode models (cached) (1/3)",
    ]);
    assert.ok(escapedSelections[1]!.options.includes("Back"));
    assert.ok(escapedSelections[1]!.options.includes("Close"));
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});
