import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  __setAdaptiveSyncDepsForTests,
  __setBulkOperationByIdForTests,
  clearBulkLaunchQuarantine,
  continueSyncRun,
  createSyncInvocationBudget,
  failSyncContinuationIfCurrent,
  reconcileSyncRuns,
} from "../src/app/lib/sync";
import {
  __resetMemorySyncStateForTests,
  __corruptDiffChunkForTests,
  __deleteDiffChunkForTests,
  createSyncRun,
  acquireSyncLock,
  getBulkLaunchFence,
  getBulkQuarantine,
  saveBulkQuarantine,
  getInputSnapshot,
  getLaunchIntent,
  getModeCheckpoint,
  getSyncRun,
  markLaunchRequestedWithFence,
  releaseSyncLock,
  saveSyncRun,
} from "../src/app/lib/sync-state";
import { GET as getSyncStatus } from "../src/app/api/sync/status/route";
import {
  __resetQstashSyncForTests,
  __setSyncContinuationPublisherForTests,
  type SyncContinuationPublishRequest,
} from "../src/app/lib/qstash-sync";
import type {
  ShopifyProductInfo,
  ShopifyProductPage,
} from "../src/app/lib/shopify-client";

const originalFetch = globalThis.fetch;
let published: SyncContinuationPublishRequest[] = [];

function product(overrides: Partial<ShopifyProductInfo> = {}): ShopifyProductInfo {
  return {
    id: "gid://shopify/Product/1",
    handle: "one",
    status: "ACTIVE",
    weightKg: null,
    excludeFrom1cStatusSync: false,
    variants: [{
      id: "gid://shopify/ProductVariant/1",
      barcode: "B1",
      sku: "S1",
      price: "10.00",
      compareAtPrice: null,
    }],
    ...overrides,
  };
}

function page(
  products: ShopifyProductInfo[],
  hasNextPage = false,
  endCursor: string | null = null,
): ShopifyProductPage {
  return { products, hasNextPage, endCursor, truncatedProductIds: [] };
}

function costVariants() {
  return new Map([
    [
      "B1",
      {
        inventoryItemId: "gid://shopify/InventoryItem/1",
        cost: "10.00",
        weightKg: null,
      },
    ],
  ]);
}

function budget(now: () => number) {
  return createSyncInvocationBudget({
    startedAt: 0,
    now,
    signal: new AbortController().signal,
  });
}

beforeEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.INTERNAL_API_KEY;
  delete process.env.SHOPIFY_ADMIN_TOKEN;
  delete process.env.SHOPIFY_STORE_DOMAIN;
  delete process.env.SHOPIFY_TARGET;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.SHOPIFY_STORE_DOMAIN_TEST = "test-shop.myshopify.com";
  process.env.SHOPIFY_ADMIN_TOKEN_TEST = "test-token";
  process.env.SYNC_CONTINUATION_BASE_URL = "https://sync.example.test";
  __resetMemorySyncStateForTests();
  __resetQstashSyncForTests();
  __setAdaptiveSyncDepsForTests(null);
  __setBulkOperationByIdForTests(null);
  published = [];
  __setSyncContinuationPublisherForTests(async (request) => {
    published.push(request);
    return { messageId: `msg-${published.length}` };
  });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ data: { currentBulkOperation: null } }),
      { status: 200 },
    )) as typeof fetch;
});

test("fast no-op prices scan completes without durable catalog artifacts", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  let now = 0;
  let pageCalls = 0;
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 10 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchPage: async () => {
      pageCalls += 1;
      now += 1_000;
      return page([product()]);
    },
  });

  const run = await continueSyncRun(accepted.runId, "manual", 0, budget(() => now));

  assert.equal(run?.status, "completed");
  assert.equal(pageCalls, 1);
  assert.equal(published.length, 0);
  assert.equal(await getModeCheckpoint(accepted.runId, "prices"), null);
  assert.equal(await getInputSnapshot(accepted.runId, "prices"), null);
});

test("empty payload alert is durable and emitted at most once per run source", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const originalError = console.error;
  let emptyAlerts = 0;
  console.error = (message?: any) => {
    if (String(message).includes("1C payload empty (prices/Prices)")) emptyAlerts += 1;
  };
  try {
    __setAdaptiveSyncDepsForTests({ fetchPrices: async () => ({}) });
    await continueSyncRun(accepted.runId, "manual", 0, budget(() => 0));
    await continueSyncRun(accepted.runId, "manual", 0, budget(() => 0));
    assert.equal(emptyAlerts, 1);
  } finally {
    console.error = originalError;
  }
});

test("deadline yield resumes from immutable input and finalizes in a fresh invocation", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  let now = 0;
  let pricesCalls = 0;
  const cursors: Array<string | null> = [];
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => {
      pricesCalls += 1;
      return { B1: 10 };
    },
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchPage: async (cursor) => {
      cursors.push(cursor);
      if (cursor === null) {
        now += 42_000;
        return page([product()], true, "opaque-secret-cursor");
      }
      now += 1_000;
      return page([product({ id: "gid://shopify/Product/2" })]);
    },
  });

  await continueSyncRun(accepted.runId, "manual", 0, budget(() => now));
  const yielded = await getModeCheckpoint(accepted.runId, "prices");
  assert.equal(yielded?.sequence, 1);
  assert.equal(yielded?.phase, "scanning");
  assert.equal(pricesCalls, 1);
  assert.equal((published[0].body as any).checkpointSequence, 1);

  now = 0;
  await continueSyncRun(accepted.runId, "manual", 1, budget(() => now));
  const ready = await getModeCheckpoint(accepted.runId, "prices");
  assert.equal(ready?.sequence, 2);
  assert.equal(ready?.phase, "ready_to_finalize");
  assert.equal(pricesCalls, 1);
  assert.deepEqual(cursors, [null, "opaque-secret-cursor"]);

  now = 0;
  const completed = await continueSyncRun(
    accepted.runId,
    "manual",
    2,
    budget(() => now),
  );
  assert.equal(completed?.status, "completed");
  assert.equal(pricesCalls, 1);
  assert.equal(await getModeCheckpoint(accepted.runId, "prices"), null);
});

test("reconciler resumes an enqueued durable checkpoint at its exact sequence", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  let now = 0;
  const cursors: Array<string | null> = [];
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 10 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchPage: async (cursor) => {
      cursors.push(cursor);
      if (cursor === null) {
        now += 42_000;
        return page([product()], true, "lost-delivery-cursor");
      }
      now += 1_000;
      return page([product({ id: "gid://shopify/Product/2" })]);
    },
  });
  await continueSyncRun(accepted.runId, "manual", 0, budget(() => now));
  assert.equal((await getModeCheckpoint(accepted.runId, "prices"))?.continuationState, "enqueued");
  now = 0;
  await reconcileSyncRuns(budget(() => now));
  const firstState = await getSyncRun(accepted.runId);
  assert.equal((await getModeCheckpoint(accepted.runId, "prices"))?.sequence, 2);
  assert.deepEqual(cursors, [null, "lost-delivery-cursor"]);
  const publishCount = published.length;
  await reconcileSyncRuns(budget(() => now));
  assert.deepEqual(cursors, [null, "lost-delivery-cursor"]);
  assert.equal(published.length, publishCount);
  assert.ok((await getSyncRun(accepted.runId))!.version >= firstState!.version);
});

test("delivery below the durable checkpoint is a stale no-op", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  let now = 0;
  let pageCalls = 0;
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 10 }), fetchDiscounts: async () => ({ B1: 0 }),
    fetchPage: async () => { pageCalls += 1; now += 42_000; return page([product()], true, "cursor"); },
  });
  await continueSyncRun(accepted.runId, "manual", 0, budget(() => now));
  const run = await getSyncRun(accepted.runId); const checkpoint = await getModeCheckpoint(accepted.runId, "prices");
  await continueSyncRun(accepted.runId, "manual", 0, budget(() => 0));
  assert.equal(pageCalls, 1);
  assert.deepEqual(await getModeCheckpoint(accepted.runId, "prices"), checkpoint);
  assert.deepEqual(await getSyncRun(accepted.runId), run);
});

for (const damage of ["missing", "corrupt"] as const) {
  test(`${damage} checkpoint diff chunk fails closed before launch`, async () => {
    const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
    let now = 0;
    let launches = 0;
    __setAdaptiveSyncDepsForTests({
      fetchPrices: async () => ({ B1: 12 }),
      fetchDiscounts: async () => ({ B1: 0 }),
      fetchPage: async () => {
        now += 40_000;
        return page([product()]);
      },
      launchBulk: async () => {
        launches += 1;
        return { id: "unexpected", status: "CREATED" };
      },
    });
    await continueSyncRun(accepted.runId, "manual", 0, budget(() => now));
    const checkpoint = await getModeCheckpoint(accepted.runId, "prices");
    assert.equal(checkpoint?.phase, "ready_to_finalize");
    if (damage === "missing") {
      __deleteDiffChunkForTests(accepted.runId, "prices", 0);
    } else {
      __corruptDiffChunkForTests(accepted.runId, "prices", 0);
    }
    now = 0;
    const result = await continueSyncRun(accepted.runId, "manual", 1, budget(() => now));
    assert.equal(result?.status, "failed");
    assert.match(result?.failureReason ?? "", /diff chunk 0/);
    assert.equal(launches, 0);
  });
}

test("price no-op reuses one complete request-local catalog for stock", async () => {
  const accepted = await createSyncRun({
    modes: ["prices", "stock"],
    source: "manual",
  });
  let now = 0;
  let pageCalls = 0;
  let stockCalls = 0;
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 10 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchStock: async () => {
      stockCalls += 1;
      now += 1_000;
      return { B1: 1 };
    },
    fetchPage: async () => {
      pageCalls += 1;
      now += 1_000;
      return page([product()]);
    },
  });

  const run = await continueSyncRun(accepted.runId, "manual", 0, budget(() => now));

  assert.equal(run?.status, "completed");
  assert.equal(pageCalls, 1);
  assert.equal(stockCalls, 1);
  assert.equal(run?.protectedSkippedByMode?.stock, 0);
});

test("insufficient reuse budget enqueues stock without a second scan", async () => {
  const accepted = await createSyncRun({
    modes: ["prices", "stock"],
    source: "manual",
  });
  let now = 0;
  let pageCalls = 0;
  let stockCalls = 0;
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 10 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchStock: async () => {
      stockCalls += 1;
      return { B1: 1 };
    },
    fetchPage: async () => {
      pageCalls += 1;
      now += 29_000;
      return page([product()]);
    },
  });

  const run = await continueSyncRun(accepted.runId, "manual", 0, budget(() => now));

  assert.equal(run?.status, "queued");
  assert.equal(run?.currentMode, "stock");
  assert.equal(pageCalls, 1);
  assert.equal(stockCalls, 0);
  assert.equal(published.length, 1);
  assert.equal((published[0].body as any).checkpointSequence, 0);
});

test("reuse budget loss after stock fetch avoids full-map traversal", async () => {
  const accepted = await createSyncRun({ modes: ["prices", "stock"], source: "manual" });
  let now = 0;
  let pageCalls = 0;
  let stockCalls = 0;
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 10 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchStock: async () => {
      stockCalls += 1;
      now += 28_000;
      return { B1: 1 };
    },
    fetchPage: async () => {
      pageCalls += 1;
      now += 1_000;
      return page([product()]);
    },
  });
  const run = await continueSyncRun(accepted.runId, "manual", 0, budget(() => now));
  assert.equal(run?.status, "queued");
  assert.equal(run?.currentMode, "stock");
  assert.equal(stockCalls, 1);
  assert.equal(pageCalls, 1);
  assert.equal(await getModeCheckpoint(accepted.runId, "stock"), null);
});

test("post-launch ambiguity fails the run and quarantines later runs", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  let now = 0;
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 12 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchPage: async () => {
      now += 1_000;
      return page([product()]);
    },
    createUpload: async () => ({ stagedUploadPath: "invocation-only-path" }),
    launchBulk: async () => {
      throw new TypeError("response lost after possible acceptance");
    },
  });

  const result = await continueSyncRun(
    accepted.runId,
    "manual",
    0,
    budget(() => now),
  );
  const quarantine = await getBulkQuarantine();
  const next = await createSyncRun({ modes: ["stock"], source: "manual" });

  assert.equal(result?.status, "failed");
  assert.equal(quarantine?.runId, accepted.runId);
  assert.equal(quarantine?.status, "ambiguous_launch");
  assert.equal(next.accepted, false);
  assert.equal(next.status, "quarantined");
  assert.doesNotMatch(JSON.stringify(quarantine), /invocation-only-path/);
  assert.equal((await getSyncRun(accepted.runId))?.activeBulkOperationId, null);
});

test("costs use the durable launch fence when Shopify acceptance is ambiguous", async () => {
  const accepted = await createSyncRun({ modes: ["costs"], source: "manual" });
  let launches = 0;
  __setAdaptiveSyncDepsForTests({
    fetchAlqitharaCosts: async () => ({ B1: 12 }),
    fetchLocalCosts: async () => ({ B1: 12 }),
    fetchVariants: async () => costVariants(),
    createUpload: async () => ({ stagedUploadPath: "costs-upload" }),
    launchBulk: async ({ mode }) => {
      assert.equal(mode, "costs");
      launches += 1;
      throw new TypeError("response lost after possible costs acceptance");
    },
  });

  const result = await continueSyncRun(
    accepted.runId,
    "manual",
    0,
    budget(() => 0),
  );
  const quarantine = await getBulkQuarantine();

  assert.equal(result?.status, "failed");
  assert.equal(launches, 1);
  assert.equal(quarantine?.runId, accepted.runId);
  assert.equal(quarantine?.mode, "costs");
  assert.equal(
    (await getLaunchIntent(accepted.runId, "costs"))?.phase,
    "ambiguous_failed",
  );

  await continueSyncRun(accepted.runId, "manual", 0, budget(() => 0));
  assert.equal(launches, 1);
});

test("costs resume a stranded launch request without relaunching", async () => {
  const accepted = await createSyncRun({ modes: ["costs"], source: "manual" });
  const token = await acquireSyncLock();
  const run = await getSyncRun(accepted.runId);
  assert.ok(token && run);
  run.status = "running";
  await saveSyncRun(run, token!);
  await markLaunchRequestedWithFence(
    {
      schemaVersion: 1,
      version: 1,
      runId: run.runId,
      mode: "costs",
      manifestHash: "c".repeat(64),
      proposedCount: 1,
      byteLength: 58,
      clientIdentifier: "sync-stranded-costs",
      stagedUploadIdentity: "costs-upload:1",
      stagedUploadAttempt: 1,
      uploadedAt: new Date().toISOString(),
      phase: "launch_requested",
      launchRequestedAt: new Date().toISOString(),
      operationId: null,
      failureReason: null,
    },
    run.storeId,
    token!,
    run.version,
    run.currentIndex,
  );
  await releaseSyncLock(token!, run.storeId);
  __setAdaptiveSyncDepsForTests({
    fetchAlqitharaCosts: async () => ({ B1: 12 }),
    fetchLocalCosts: async () => ({ B1: 12 }),
    fetchVariants: async () => costVariants(),
    createUpload: async () => {
      throw new Error("must not re-upload a stranded costs launch");
    },
    launchBulk: async () => {
      throw new Error("must not relaunch a stranded costs mutation");
    },
  });

  const result = await continueSyncRun(
    accepted.runId,
    "manual",
    0,
    budget(() => 0),
  );

  assert.equal(result?.status, "failed");
  assert.equal((await getBulkQuarantine())?.mode, "costs");
  assert.equal(
    (await getLaunchIntent(accepted.runId, "costs"))?.phase,
    "ambiguous_failed",
  );
});

test("costs atomically associate the returned bulk operation", async () => {
  const accepted = await createSyncRun({ modes: ["costs"], source: "manual" });
  __setAdaptiveSyncDepsForTests({
    fetchAlqitharaCosts: async () => ({ B1: 12 }),
    fetchLocalCosts: async () => ({ B1: 12 }),
    fetchVariants: async () => costVariants(),
    createUpload: async () => ({ stagedUploadPath: "costs-upload" }),
    launchBulk: async () => ({
      id: "gid://shopify/BulkOperation/costs-associated",
      status: "CREATED",
    }),
  });

  const result = await continueSyncRun(
    accepted.runId,
    "manual",
    0,
    budget(() => 0),
  );

  assert.equal(result?.status, "waiting_bulk");
  assert.equal(
    result?.activeBulkOperationId,
    "gid://shopify/BulkOperation/costs-associated",
  );
  assert.equal(result?.proposedByMode.costs, 1);
  assert.equal(
    (await getLaunchIntent(accepted.runId, "costs"))?.phase,
    "associated",
  );
  assert.equal(await getBulkLaunchFence(), null);
});

test("alias quarantine is visible in status and clearable from the current target", async () => {
  process.env.INTERNAL_API_KEY = "internal-test-key";
  process.env.SHOPIFY_STORE_DOMAIN = "prod-shop.myshopify.com";
  process.env.SHOPIFY_ADMIN_TOKEN = "prod-token";
  process.env.SHOPIFY_TARGET = "test";
  const quarantine = {
    schemaVersion: 1 as const,
    storeId: "prod-shop.myshopify.com",
    runId: "prod-ambiguous-run",
    mode: "prices" as const,
    quarantineToken: "alias-quarantine-token",
    manifestHash: "a".repeat(64),
    clientIdentifier: "alias-client",
    knownOperationId: null,
    status: "ambiguous_launch" as const,
    reason: "ambiguous production launch",
    launchRequestedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    noActiveCheckTimestamps: [],
  };
  await saveBulkQuarantine(quarantine);

  const response = await getSyncStatus(
    new Request("https://sync.example.test/api/sync/status", {
      headers: { "x-api-key": process.env.INTERNAL_API_KEY },
    }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.admissionBlocker.storeId, quarantine.storeId);
  assert.equal(
    payload.admissionBlocker.quarantine.quarantineToken,
    quarantine.quarantineToken,
  );
  globalThis.fetch = (async (input, init) => {
    assert.match(String(input), /^https:\/\/prod-shop\.myshopify\.com\//);
    assert.equal(
      (init?.headers as Record<string, string>)["X-Shopify-Access-Token"],
      "prod-token",
    );
    return new Response(
      JSON.stringify({ data: { currentBulkOperation: null } }),
      { status: 200 },
    );
  }) as typeof fetch;
  assert.equal(
    await clearBulkLaunchQuarantine({
      quarantineToken: quarantine.quarantineToken,
    }),
    true,
  );
  assert.equal(await getBulkQuarantine(quarantine.storeId), null);
  assert.equal(await getBulkLaunchFence(quarantine.storeId), null);
});

test("association failure after a returned operation quarantines without relaunch", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  let launchCalls = 0;
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 12 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchPage: async () => page([product()]),
    createUpload: async () => ({ stagedUploadPath: "invocation-only-path" }),
    launchBulk: async () => {
      launchCalls += 1;
      return { id: "gid://shopify/BulkOperation/unassociated", status: "CREATED" };
    },
    associateBulk: async () => {
      throw new Error("Redis association response lost");
    },
  });

  const result = await continueSyncRun(
    accepted.runId,
    "manual",
    0,
    budget(() => 0),
  );
  const quarantine = await getBulkQuarantine();

  assert.equal(result?.status, "failed");
  assert.equal(launchCalls, 1);
  assert.equal(quarantine?.runId, accepted.runId);
  assert.equal(quarantine?.knownOperationId, "gid://shopify/BulkOperation/unassociated");
  assert.match(quarantine?.reason ?? "", /atomic association failed/);
  assert.equal((await getSyncRun(accepted.runId))?.activeBulkOperationId, null);

  await continueSyncRun(accepted.runId, "manual", 0, budget(() => 0));
  assert.equal(launchCalls, 1);
});

test("quarantine terminal proof rejects unrelated operation IDs", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 12 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchPage: async () => page([product()]),
    createUpload: async () => ({ stagedUploadPath: "private" }),
    launchBulk: async () => ({ id: "gid://shopify/BulkOperation/known", status: "CREATED" }),
    associateBulk: async () => false,
  });
  await continueSyncRun(accepted.runId, "manual", 0, budget(() => 0));
  const quarantine = await getBulkQuarantine();
  __setBulkOperationByIdForTests(async (id) => ({
    id,
    status: "COMPLETED",
    errorCode: null,
    type: "MUTATION",
    url: null,
    partialDataUrl: null,
  }));
  assert.equal(await clearBulkLaunchQuarantine({
    quarantineToken: quarantine!.quarantineToken,
    terminalOperationId: "gid://shopify/BulkOperation/unrelated",
  }), false);
  assert.equal(await clearBulkLaunchQuarantine({
    quarantineToken: quarantine!.quarantineToken,
    terminalOperationId: "gid://shopify/BulkOperation/known",
  }), true);
});

test("operator quarantine clear rejects while a mutation is active", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 12 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchPage: async () => page([product()]),
    createUpload: async () => ({ stagedUploadPath: "private" }),
    launchBulk: async () => ({ id: "gid://shopify/BulkOperation/known-active", status: "CREATED" }),
    associateBulk: async () => false,
  });
  await continueSyncRun(accepted.runId, "manual", 0, budget(() => 0));
  const quarantine = await getBulkQuarantine();
  __setAdaptiveSyncDepsForTests({
    getCurrentBulk: async () => ({
      id: "gid://shopify/BulkOperation/active",
      status: "RUNNING",
      errorCode: null,
      type: "MUTATION",
      url: null,
      partialDataUrl: null,
    }),
  });
  assert.equal(await clearBulkLaunchQuarantine({
    quarantineToken: quarantine!.quarantineToken,
    terminalOperationId: "gid://shopify/BulkOperation/known-active",
  }), false);
  assert.ok(await getBulkQuarantine());
});

test("failed quarantine transaction leaves durable launch fence blocking new runs", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 12 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchPage: async () => page([product()]),
    createUpload: async () => ({ stagedUploadPath: "private" }),
    launchBulk: async () => { throw new TypeError("ambiguous response"); },
    fenceAmbiguous: async () => { throw new Error("quarantine transaction unavailable"); },
  });
  const failed = await continueSyncRun(accepted.runId, "manual", 0, budget(() => 0));
  const next = await createSyncRun({ modes: ["stock"], source: "manual" });
  assert.equal(failed?.status, "failed");
  assert.equal(next.status, "quarantined");
  assert.equal(next.accepted, false);
});

test("matching continuation failure after launch_requested creates operator-clearable quarantine", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const token = await acquireSyncLock();
  assert.ok(token);
  const run = await getSyncRun(accepted.runId);
  assert.ok(run);
  run.status = "running";
  await saveSyncRun(run, token!);
  const intent = {
    schemaVersion: 1 as const, version: 1, runId: run.runId, mode: "prices" as const,
    manifestHash: "f".repeat(64), proposedCount: 1, byteLength: 10,
    clientIdentifier: "sync-failure", stagedUploadIdentity: "upload:1", stagedUploadAttempt: 1,
    uploadedAt: new Date().toISOString(), phase: "launch_requested" as const,
    launchRequestedAt: new Date().toISOString(), operationId: null, failureReason: null,
  };
  await markLaunchRequestedWithFence(intent, run.storeId, token!, run.version, run.currentIndex);
  await releaseSyncLock(token!, run.storeId);
  const outcome = await failSyncContinuationIfCurrent({
    payload: {
      kind: "continue-run",
      runId: run.runId,
      source: "manual",
      currentIndex: run.currentIndex,
      currentMode: "prices",
      runVersion: run.version,
      checkpointSequence: 0,
    },
    reason: "delivery exhausted after launch",
  });
  assert.equal(outcome, "marked_ambiguous");
  const quarantine = await getBulkQuarantine(run.storeId);
  assert.equal(quarantine?.runId, run.runId);
  assert.equal(quarantine?.status, "ambiguous_launch");
  assert.equal((await getLaunchIntent(run.runId, "prices"))?.phase, "ambiguous_failed");
});

test("resuming a launch_requested intent whose diff moved quarantines instead of stranding the fence", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const token = await acquireSyncLock();
  const run = await getSyncRun(accepted.runId);
  assert.ok(token && run);
  run.status = "running";
  await saveSyncRun(run, token!);
  // A dead invocation left a launch_requested intent and a durable fence behind,
  // with no checkpoint and no input snapshot to resume from.
  await markLaunchRequestedWithFence(
    {
      schemaVersion: 1, version: 1, runId: run.runId, mode: "prices",
      manifestHash: "f".repeat(64), proposedCount: 1, byteLength: 10,
      clientIdentifier: "sync-stranded", stagedUploadIdentity: "upload:1",
      stagedUploadAttempt: 1, uploadedAt: new Date().toISOString(),
      phase: "launch_requested", launchRequestedAt: new Date().toISOString(),
      operationId: null, failureReason: null,
    },
    run.storeId, token!, run.version, run.currentIndex,
  );
  await releaseSyncLock(token!, run.storeId);

  // The resume rescans against fresh 1C data, so the recomputed manifest differs
  // from the persisted one. That must fence, not throw.
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 99 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchPage: async () => page([product()]),
    createUpload: async () => { throw new Error("must not re-upload an ambiguous launch"); },
    launchBulk: async () => { throw new Error("must not relaunch an ambiguous launch"); },
  });

  const result = await continueSyncRun(accepted.runId, "manual", 0, budget(() => 0));
  assert.equal(result?.status, "failed");
  const quarantine = await getBulkQuarantine(run.storeId);
  assert.equal(quarantine?.runId, run.runId);
  assert.equal(quarantine?.status, "ambiguous_launch");
  assert.match(quarantine?.reason ?? "", /no longer matches the recomputed diff/);
  assert.equal((await getLaunchIntent(run.runId, "prices"))?.phase, "ambiguous_failed");

  // The store is blocked, but recoverably: the token clears both records.
  assert.equal(
    (await createSyncRun({ modes: ["stock"], source: "cron" })).status,
    "quarantined",
  );
  assert.equal(await clearBulkLaunchQuarantine({
    quarantineToken: quarantine!.quarantineToken,
  }), true);
  assert.equal(
    (await createSyncRun({ modes: ["stock"], source: "cron" })).accepted,
    true,
  );
});

test("a fence left with no quarantine is adopted so the reconciler can clear it", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  const token = await acquireSyncLock();
  const run = await getSyncRun(accepted.runId);
  assert.ok(token && run);
  run.status = "running";
  await saveSyncRun(run, token!);
  const launchRequestedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await markLaunchRequestedWithFence(
    {
      schemaVersion: 1, version: 1, runId: run.runId, mode: "prices",
      manifestHash: "a".repeat(64), proposedCount: 1, byteLength: 10,
      clientIdentifier: "sync-orphan", stagedUploadIdentity: "upload:1",
      stagedUploadAttempt: 1, uploadedAt: launchRequestedAt,
      phase: "launch_requested", launchRequestedAt, operationId: null, failureReason: null,
    },
    run.storeId, token!, run.version, run.currentIndex,
  );
  await releaseSyncLock(token!, run.storeId);
  // Simulate the run and intent aging out while the fence survives: the run is
  // terminal, so markAmbiguousBulkLaunchAtomically can no longer produce the
  // quarantine that deleteBulkQuarantine needs.
  const terminal = await getSyncRun(run.runId);
  terminal!.status = "failed";
  terminal!.failureReason = "invocation lost";
  await saveSyncRun(terminal!);
  assert.equal(await getBulkQuarantine(run.storeId), null);
  assert.equal(
    (await createSyncRun({ modes: ["stock"], source: "cron" })).status,
    "quarantined",
  );

  // Three spaced no-active checks past the minimum age clear it without an operator.
  for (let pass = 0; pass < 3; pass += 1) {
    await reconcileSyncRuns(budget(() => 0));
    const pending = await getBulkQuarantine(run.storeId);
    if (!pending) break;
    // Age the recorded checks so the next pass clears the 5-minute spacing gate.
    pending.noActiveCheckTimestamps = pending.noActiveCheckTimestamps.map(
      (_, index, all) =>
        new Date(Date.now() - (all.length - index) * 6 * 60 * 1000).toISOString(),
    );
    await saveBulkQuarantine(pending);
  }

  assert.equal(await getBulkQuarantine(run.storeId), null);
  assert.equal(await getBulkLaunchFence(run.storeId), null);
  assert.equal(
    (await createSyncRun({ modes: ["stock"], source: "cron" })).accepted,
    true,
  );
});

test("abort before launch recreates upload and launches only on retry", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  let uploadCalls = 0;
  let launchCalls = 0;
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async () => ({ B1: 12 }),
    fetchDiscounts: async () => ({ B1: 0 }),
    fetchPage: async () => page([product()]),
    createUpload: async () => {
      uploadCalls += 1;
      if (uploadCalls === 1) throw new DOMException("deadline", "AbortError");
      return { stagedUploadPath: "retry-invocation-only-path" };
    },
    launchBulk: async () => {
      launchCalls += 1;
      return { id: "gid://shopify/BulkOperation/retried", status: "CREATED" };
    },
  });

  const first = await continueSyncRun(
    accepted.runId,
    "manual",
    0,
    budget(() => 0),
  );
  assert.equal(first?.status, "queued");
  assert.equal((await getLaunchIntent(accepted.runId, "prices"))?.phase, "prepared");
  assert.equal(launchCalls, 0);

  const second = await continueSyncRun(
    accepted.runId,
    "manual",
    0,
    budget(() => 0),
  );
  const intent = await getLaunchIntent(accepted.runId, "prices");

  assert.equal(second?.status, "waiting_bulk");
  assert.equal(uploadCalls, 2);
  assert.equal(launchCalls, 1);
  assert.equal(intent?.phase, "associated");
  assert.equal(intent?.stagedUploadAttempt, 2);
  assert.doesNotMatch(JSON.stringify(intent), /retry-invocation-only-path/);
});

test("canonical manifest launches once and associates the returned operation", async () => {
  const accepted = await createSyncRun({ modes: ["prices"], source: "manual" });
  let now = 0;
  let launchCalls = 0;
  let uploadedJsonl = "";
  let sharedSignal: AbortSignal | undefined;
  __setAdaptiveSyncDepsForTests({
    fetchPrices: async (signal) => {
      sharedSignal = signal;
      return { B1: 12, B2: 13 };
    },
    fetchDiscounts: async (signal) => {
      assert.equal(signal, sharedSignal);
      return { B1: 0, B2: 0 };
    },
    fetchPage: async (_cursor, options) => {
      assert.equal(options?.signal, sharedSignal);
      now += 1_000;
      return page([
        product({
          id: "gid://shopify/Product/2",
          variants: [{
            id: "gid://shopify/ProductVariant/2",
            barcode: "B2",
            price: "10.00",
            compareAtPrice: null,
          }],
        }),
        product(),
      ]);
    },
    createUpload: async ({ jsonl, signal }) => {
      assert.equal(signal, sharedSignal);
      uploadedJsonl = jsonl;
      return { stagedUploadPath: "secret-not-persisted" };
    },
    launchBulk: async ({ signal }) => {
      assert.equal(signal, sharedSignal);
      launchCalls += 1;
      return { id: "gid://shopify/BulkOperation/associated", status: "CREATED" };
    },
  });

  const result = await continueSyncRun(
    accepted.runId,
    "manual",
    0,
    budget(() => now),
  );
  const rows = uploadedJsonl.split("\n").map((line) => JSON.parse(line));
  const intent = await getLaunchIntent(accepted.runId, "prices");

  assert.equal(result?.status, "waiting_bulk");
  assert.equal(result?.activeBulkOperationId, "gid://shopify/BulkOperation/associated");
  assert.equal(launchCalls, 1);
  assert.deepEqual(rows.map((row) => row.productId), [
    "gid://shopify/Product/1",
    "gid://shopify/Product/2",
  ]);
  assert.equal(intent?.phase, "associated");
  assert.doesNotMatch(JSON.stringify(intent), /secret-not-persisted/);

  await continueSyncRun(accepted.runId, "manual", 0, budget(() => now));
  assert.equal(launchCalls, 1);
});

test("nested variant truncation fails before upload or mutation", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "manual" });
  let uploads = 0;
  let launches = 0;
  __setAdaptiveSyncDepsForTests({
    fetchStock: async () => ({ B1: 1 }),
    fetchPage: async () => ({
      ...page([product()]),
      truncatedProductIds: ["gid://shopify/Product/1"],
    }),
    createUpload: async () => {
      uploads += 1;
      return { stagedUploadPath: "unused" };
    },
    launchBulk: async () => {
      launches += 1;
      return { id: "unused", status: "CREATED" };
    },
  });

  const result = await continueSyncRun(accepted.runId, "manual", 0, budget(() => 0));

  assert.equal(result?.status, "failed");
  assert.match(result?.failureReason ?? "", /shopify_product_variants_truncated/);
  assert.equal(uploads, 0);
  assert.equal(launches, 0);
});

test("fast protected stock scan persists its distinct protected count", async () => {
  const accepted = await createSyncRun({ modes: ["stock"], source: "cron" });
  __setAdaptiveSyncDepsForTests({
    fetchStock: async () => ({ B1: 0 }),
    fetchPage: async () =>
      page([product({ excludeFrom1cStatusSync: true })]),
  });

  const result = await continueSyncRun(accepted.runId, "cron", 0, budget(() => 0));

  assert.equal(result?.status, "completed");
  assert.equal(result?.proposedByMode.stock, 0);
  assert.equal(result?.protectedSkippedByMode?.stock, 1);
});

test.after(() => {
  globalThis.fetch = originalFetch;
  __setAdaptiveSyncDepsForTests(null);
});
