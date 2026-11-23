import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createModelCatalog, DEFAULT_MODEL, fetchFreeOpenRouterModels, say } from "../src/index.ts";
import { ask, fauxHarness, tempDir } from "./helpers.ts";

test("the live catalog exposes only free models and falls back from a paid default", () => {
  const catalog = createModelCatalog({
    provider: "openrouter",
    defaultModel: "anthropic/claude-haiku-5.5",
  });
  assert.deepEqual(catalog.defaultModel, { provider: "openrouter", modelId: "openrouter/free" });
  const list = catalog.list();
  assert.equal(list[0].id, DEFAULT_MODEL);
  assert.ok(list.some((model) => model.id.endsWith(":free")));
  for (const model of list) {
    assert.ok(model.id === DEFAULT_MODEL || model.id.endsWith(":free"));
    assert.deepEqual(model.cost, { input: 0, output: 0 });
    assert.equal(
      catalog.models.getModel(catalog.provider, model.id)?.contextWindow,
      model.contextWindow,
    );
  }
  assert.throws(() => catalog.ref("anthropic/claude-haiku-5.5"), /Unknown model/);
});

test("discovery registers current free chat models with tool support", async (t) => {
  const model = {
    id: "test/new-model:free",
    name: "New Model",
    context_length: 65_536,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools"],
  };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: [
        model,
        { ...model, id: "test/no-tools:free", supported_parameters: [] },
        { ...model, id: "test/paid:free", pricing: { prompt: "0", completion: "0.01" } },
        { ...model, id: "test/paid" },
      ],
    }),
  );
  const catalog = createModelCatalog({
    provider: "openrouter",
    openRouterModels: await fetchFreeOpenRouterModels("test-key"),
  });
  assert.deepEqual(
    catalog.list().map(({ id }) => id),
    [DEFAULT_MODEL, model.id],
  );
  assert.equal(
    catalog.models.getModel(catalog.provider, model.id)?.contextWindow,
    model.context_length,
  );
});

test("the harness stores in WAL, answers on the faux model, and offers no bash or file tools", async () => {
  const t = tempDir();
  try {
    const { ctx, root, close } = await fauxHarness(
      t.dir,
      [(turn) => say(`hello ${turn.lastUser}`)],
      [],
    );
    const settled = await ask(root, ctx, "world");
    assert.equal(settled.status, "done");
    const agent = await root.agent(ctx);
    assert.deepEqual(
      agent.tools.map((x) => x.name),
      [],
    );
    const db = new DatabaseSync(join(t.dir, "agent.sqlite"));
    assert.equal((db.prepare("PRAGMA journal_mode").get() as any).journal_mode, "wal");
    db.close();
    await close();
  } finally {
    t.cleanup();
  }
});

test("a second process cannot open the same agent database", async () => {
  const t = tempDir();
  try {
    const first = await fauxHarness(t.dir, [], []);
    const other = spawnSync(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "fixtures/host.ts"), t.dir, "resume"],
      { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /already owned by process/);
    await first.close();
  } finally {
    t.cleanup();
  }
});
