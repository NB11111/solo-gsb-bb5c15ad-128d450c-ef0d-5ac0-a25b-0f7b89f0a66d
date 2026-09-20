"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inferSchema } = require("../infer");
const {
  mineRelations,
  enhanceSchema,
  collectScopes,
  reduceImplications,
  MAX_SAMPLES,
  MIN_SUPPORT,
} = require("../relation");

function ids(group, kind) {
  const rules = kind === "implication" ? group.implications : group.exclusions;
  return rules.map((r) => `${r.a}${kind === "implication" ? "->" : "/"}${r.b}`);
}

test("collectScopes counts every object instance per pointer and array elements independently", () => {
  const samples = [
    { id: 1, list: [{ a: 1, b: 2 }, { a: 3 }] },
    { id: 2, list: [{ a: 4 }] },
  ];
  const { scopes, pointerOrder } = collectScopes(samples);
  // 2 root objects + 3 item objects = 5 scopes.
  assert.equal(scopes.length, 5);
  assert.deepEqual(pointerOrder, ["", "/properties/list/items"]);

  const roots = scopes.filter((s) => s.pointer === "");
  assert.deepEqual(
    roots.map((s) => [...s.present].sort()),
    [
      ["id", "list"],
      ["id", "list"],
    ]
  );

  const items = scopes.filter((s) => s.pointer === "/properties/list/items");
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((s) => s.path), ["#/0/list/0", "#/0/list/1", "#/1/list/0"]);
  assert.deepEqual([...items[0].present].sort(), ["a", "b"]);
  assert.deepEqual([...items[1].present], ["a"]);
  // Item fields never leak into the root scope (no cross-scope association).
  for (const root of roots) {
    assert.equal(root.present.has("a"), false);
    assert.equal(root.present.has("b"), false);
  }
});

test("collectScopes treats nested object fields as their own scope", () => {
  const samples = [{ addr: { city: "x", zip: "1" } }, { addr: { city: "y" } }];
  const { scopes, pointerOrder } = collectScopes(samples);
  assert.deepEqual(pointerOrder, ["", "/properties/addr"]);
  const addrScopes = scopes.filter((s) => s.pointer === "/properties/addr");
  assert.equal(addrScopes.length, 2);
  assert.deepEqual([...addrScopes[0].present].sort(), ["city", "zip"]);
});

test("collectScopes ignores scalars and nulls at object scope positions", () => {
  const { scopes } = collectScopes([1, "x", null, true]);
  assert.equal(scopes.length, 0);
});

test("mineRelations reports implication candidates with support>=2 and 100% confidence", () => {
  const samples = [
    { id: 1, phone: "a", home: "h" },
    { id: 2, phone: "b", home: "i" },
    { id: 3 },
  ];
  const mined = mineRelations({ samples });
  assert.equal(mined.sampleCount, 3);
  assert.equal(mined.scopeCount, 3);
  const root = mined.scopes.find((g) => g.scopePointer === "");
  // {phone, home} is a 2-node SCC; both imply id. The SCC keeps its cycle
  // plus one representative edge to id (smallest first-seen field pair).
  assert.deepEqual(
    ids(root, "implication").sort(),
    ["home->phone", "phone->home", "phone->id"]
  );
  const phoneImpliesHome = root.implications.find((r) => r.a === "phone" && r.b === "home");
  assert.equal(phoneImpliesHome.support, 2);
  assert.equal(phoneImpliesHome.confidence, 1);
  assert.deepEqual(phoneImpliesHome.sampleIndexes, [0, 1]);
  assert.deepEqual(phoneImpliesHome.witnessPaths, ["#/0", "#/1"]);
});

test("mineRelations requires support >= 2 for implications", () => {
  const samples = [
    { id: 1, rare: "x", b: 1 },
    { id: 2 },
    { id: 3 },
  ];
  const root = mineRelations({ samples }).scopes[0];
  // "rare" only appears once: even though rare->id holds, support is 1.
  assert.equal(root.implications.some((r) => r.a === "rare"), false);
});

test("mineRelations drops implications with a counterexample", () => {
  const samples = [
    { a: 1, b: 2 },
    { a: 3 },
  ];
  const root = mineRelations({ samples }).scopes[0];
  assert.equal(root.implications.some((r) => r.a === "a" && r.b === "b"), false);
  // b -> a does hold with support 1, still below the threshold -> no rules.
  assert.equal(root.implications.length, 0);
});

test("mineRelations reports mutually exclusive pairs with per-side support >= 2", () => {
  const samples = [
    { a: 1, b: 2 },
    { a: 3, b: 4 },
    { c: true },
    { c: false },
  ];
  const root = mineRelations({ samples }).scopes[0];
  const pairs = ids(root, "exclusion");
  assert.ok(pairs.includes("a/c"));
  assert.ok(pairs.includes("b/c"));
  assert.equal(pairs.includes("a/b"), false); // co-occur
  const ac = root.exclusions.find((r) => r.a === "a" && r.b === "c");
  assert.equal(ac.support, 2);
  assert.equal(ac.countA, 2);
  assert.equal(ac.countB, 2);
  assert.equal(ac.coOccurrence, 0);
  assert.deepEqual(ac.witnessPathsA, ["#/0", "#/1"]);
  assert.deepEqual(ac.witnessPathsB, ["#/2", "#/3"]);
});

test("mineRelations does not report exclusions when one side has support 1", () => {
  const samples = [{ a: 1 }, { b: 2 }, { a: 3 }];
  const root = mineRelations({ samples }).scopes[0];
  assert.deepEqual(root.exclusions, []);
});

test("mineRelations mines independently inside array item scopes", () => {
  const samples = [
    { list: [{ a: 1, b: 2 }, { a: 3, b: 4 }] },
    { list: [{ a: 5 }] },
  ];
  const mined = mineRelations({ samples });
  const items = mined.scopes.find((g) => g.scopePointer === "/properties/list/items");
  assert.equal(items.scopeCount, 3);
  // b appears only alongside a (support 2); a also appears alone, so the
  // implication is one-directional.
  assert.deepEqual(ids(items, "implication"), ["b->a"]);
  const rule = items.implications[0];
  assert.equal(rule.support, 2);
  // Witnesses are observation paths inside the samples, with global indexes.
  assert.deepEqual(rule.witnessPaths, ["#/0/list/0", "#/0/list/1"]);
  assert.deepEqual(rule.sampleIndexes, [0]);
});

test("mineRelations never associates fields across scopes", () => {
  // Field "a" only ever appears in items; field "b" only ever at the root:
  // the two must not be compared to each other at all.
  const samples = [{ b: 1, list: [{ a: 1 }, { a: 2 }] }, { b: 2, list: [{ a: 3 }] }];
  const mined = mineRelations({ samples });
  for (const group of mined.scopes) {
    for (const rule of [...group.implications, ...group.exclusions]) {
      const fields = [rule.a, rule.b].sort().join();
      assert.notEqual(fields, "a,b");
    }
  }
});

test("reduceImplications drops transitive edges on a DAG chain", () => {
  // Nodes: A(0) -> B(1) -> C(2), plus A -> C directly.
  const kept = reduceImplications(["A", "B", "C"], [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
    { from: 0, to: 2 },
  ]);
  assert.deepEqual(kept, [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
  ]);
});

test("reduceImplications keeps one directed cycle for an equivalence SCC", () => {
  // A <-> B plus both imply C; the SCC keeps the 2-cycle A->B, B->A and one
  // representative edge B->C (A->C is transitively implied).
  const kept = reduceImplications(["A", "B", "C"], [
    { from: 0, to: 1 },
    { from: 1, to: 0 },
    { from: 0, to: 2 },
    { from: 1, to: 2 },
  ]);
  assert.deepEqual(
    kept.map((e) => `${e.from}${e.to}`).sort(),
    ["01", "02", "10"]
  );
});

test("mineRelations reports the number of edges removed by transitive reduction", () => {
  const samples = [
    { a: 1, b: 2, c: 3 },
    { a: 4, b: 5, c: 6 },
  ];
  const mined = mineRelations({ samples });
  // 6 raw pairwise implications (clique over 3 fields); reduction keeps 3
  // cycle edges, so 3 are removed.
  assert.equal(mined.summary.removedByTransitiveReduction, 3);
  assert.equal(mined.scopes[0].implications.length, 3);
});

test("mineRelations flags rules already enforced by plain required", () => {
  const samples = [
    { id: 1, a: 1, b: 2 },
    { id: 2, a: 3, b: 4 },
    { id: 3 },
  ];
  const { schema } = inferSchema(samples);
  const root = mineRelations({ samples, schema }).scopes[0];
  // id is required everywhere; a/b always co-occur (2-node SCC).
  const aToId = root.implications.find((r) => r.a === "a" && r.b === "id");
  assert.equal(aToId.alreadyEnforced, true);
  const aToB = root.implications.find((r) => r.a === "a" && r.b === "b");
  assert.equal(aToB.alreadyEnforced, false);
});

test("mineRelations scopes each carry field presence counts", () => {
  const samples = [{ a: 1, b: 2 }, { a: 3 }, { c: 1 }];
  const group = mineRelations({ samples }).scopes[0];
  assert.deepEqual(group.fields, [
    { name: "a", count: 2 },
    { name: "b", count: 1 },
    { name: "c", count: 1 },
  ]);
});

test("enhanceSchema injects dependentRequired and not/required for the picked rules", () => {
  const samples = [
    { id: 1, a: 1, b: 2 },
    { id: 2, a: 3, b: 4 },
    { id: 3, c: true },
    { id: 4, c: false },
  ];
  const { schema } = inferSchema(samples);
  const mined = mineRelations({ samples, schema });
  const root = mined.scopes[0];
  const ruleIds = [
    ...root.implications.filter((r) => !r.alreadyEnforced).map((r) => r.id),
    ...root.exclusions.map((r) => r.id),
  ];
  const out = enhanceSchema({ schema, samples, ruleIds });

  assert.equal(out.ruleCount, ruleIds.length);
  assert.equal(out.sampleCount, 4);
  assert.deepEqual(out.schema.dependentRequired, { a: ["b"], b: ["a"] });
  assert.deepEqual(out.schema.allOf, [
    { not: { required: ["a", "c"] } },
    { not: { required: ["b", "c"] } },
  ]);
  assert.equal(out.schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("enhanceSchema merges multiple implications sharing the same antecedent", () => {
  // a always comes with both b and c; b and c are independent otherwise, so
  // neither a->b nor a->c is transitively implied by the other.
  const samples = [
    { a: 1, b: 2, c: 3 },
    { a: 4, b: 5, c: 6 },
    { b: 7 },
    { c: 8 },
  ];
  const mined = mineRelations({ samples }).scopes[0];
  const aRules = mined.implications.filter((r) => r.a === "a").map((r) => r.id);
  assert.deepEqual(
    aRules.map((id) => id.split("|")[2]).sort(),
    ["a->b", "a->c"]
  );
  const { schema } = inferSchema(samples);
  const out = enhanceSchema({ schema, samples, ruleIds: aRules });
  assert.deepEqual(out.schema.dependentRequired.a, ["b", "c"]);
});

test("enhanceSchema places rules on nested and array item scopes", () => {
  const samples = [
    { list: [{ a: 1, b: 2 }, { a: 3, b: 4 }] },
    { list: [{ a: 5, b: 6 }] },
  ];
  const { schema } = inferSchema(samples);
  const group = mineRelations({ samples }).scopes.find(
    (g) => g.scopePointer === "/properties/list/items"
  );
  const ruleIds = group.implications.map((r) => r.id);
  const out = enhanceSchema({ schema, samples, ruleIds });
  assert.deepEqual(out.schema.properties.list.items.dependentRequired, {
    a: ["b"],
    b: ["a"],
  });
});

test("enhanceSchema rejects documents that violate the mined rules", () => {
  const samples = [
    { a: 1, b: 2 },
    { a: 3, b: 4 },
    { c: 1 },
    { c: 2 },
  ];
  const { schema } = inferSchema(samples);
  const ruleIds = ["exclusion||a<x>c", "implication||a->b"];
  const out = enhanceSchema({ schema, samples, ruleIds });
  const Ajv2020 = require("ajv/dist/2020").default;
  const validate = new Ajv2020({ strict: false }).compile(out.schema);
  assert.equal(validate({ a: 1, b: 2 }), true);
  assert.equal(validate({ c: 1 }), true);
  assert.equal(validate({ a: 1 }), false); // dependentRequired
  assert.equal(validate({ a: 1, b: 2, c: 3 }), false); // not/required
});

test("enhanceSchema refuses (422, no schema) when an original sample fails Ajv", () => {
  // The implication holds on the samples, but the supplied schema rejects
  // them via an unrelated constraint, simulating schema/sample drift.
  const schema = {
    type: "object",
    properties: { a: { type: "integer", minimum: 100 }, b: { type: "integer" } },
  };
  assert.throws(
    () =>
      enhanceSchema({
        schema,
        samples: [
          { a: 1, b: 2 },
          { a: 3, b: 4 },
        ],
        ruleIds: ["implication||a->b", "implication||b->a"],
      }),
    (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /复验/);
      assert.equal(err.details.failures.length, 2);
      assert.equal(err.details.failures[0].errors[0].keyword, "minimum");
      return true;
    }
  );
});

test("enhanceSchema refuses unknown or stale rule ids with per-id reasons", () => {
  const samples = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  const { schema } = inferSchema(samples);
  try {
    enhanceSchema({ schema, samples, ruleIds: ["implication||nope->zzz"] });
    assert.unreachable("should have thrown");
  } catch (err) {
    assert.equal(err.status, 422);
    assert.equal(err.details.invalidRules.length, 1);
    assert.equal(err.details.invalidRules[0].id, "implication||nope->zzz");
  }
});

test("enhanceSchema deduplicates repeated rule ids", () => {
  const samples = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  const { schema } = inferSchema(samples);
  const out = enhanceSchema({
    schema,
    samples,
    ruleIds: ["implication||a->b", "implication||a->b"],
  });
  assert.equal(out.ruleCount, 1);
  assert.deepEqual(out.ruleIds, ["implication||a->b"]);
});

test("enhanceSchema supports RFC 6901 escaped field names", () => {
  const samples = [
    { "a/b": 1, "c~d": 2 },
    { "a/b": 3, "c~d": 4 },
  ];
  const { schema } = inferSchema(samples);
  const mined = mineRelations({ samples }).scopes[0];
  const id = mined.implications.find((r) => r.a === "a/b" && r.b === "c~d").id;
  assert.match(id, /a~1b/);
  assert.match(id, /c~0d/);
  const out = enhanceSchema({ schema, samples, ruleIds: [id] });
  assert.deepEqual(out.schema.dependentRequired, { "a/b": ["c~d"] });
});

test("mineRelations validates its input shape and sample cap", () => {
  for (const bad of [undefined, null, [], "x", 42]) {
    assert.throws(() => mineRelations({ samples: bad }), (err) => err.status === 400);
  }
  assert.throws(
    () => mineRelations({ samples: Array.from({ length: MAX_SAMPLES + 1 }, () => ({})) }),
    (err) => err.status === 400 && new RegExp(MAX_SAMPLES).test(err.message)
  );
  assert.throws(
    () => mineRelations({ samples: [{}], schema: [] }),
    (err) => err.status === 400 && /'schema' object/.test(err.message)
  );
});

test("mineRelations at the sample cap succeeds and finds no rules on empty objects", () => {
  const out = mineRelations({
    samples: Array.from({ length: MAX_SAMPLES }, () => ({})),
  });
  assert.equal(out.sampleCount, MAX_SAMPLES);
  assert.equal(out.summary.implication, 0);
  assert.equal(out.summary.exclusion, 0);
});

test("enhanceSchema validates its input shape", () => {
  assert.throws(
    () => enhanceSchema({ schema: null, samples: [{}], ruleIds: [] }),
    (err) => err.status === 400 && /'schema' object/.test(err.message)
  );
  assert.throws(
    () => enhanceSchema({ schema: {}, samples: [], ruleIds: [] }),
    (err) => err.status === 400 && /'samples' array/.test(err.message)
  );
  assert.throws(
    () => enhanceSchema({ schema: {}, samples: [{}] }),
    (err) => err.status === 400 && /'ruleIds' array/.test(err.message)
  );
  assert.throws(
    () => enhanceSchema({ schema: {}, samples: [{}], ruleIds: [42] }),
    (err) => err.status === 400 && /rule id/.test(err.message)
  );
});

test("MIN_SUPPORT is exactly 2", () => {
  assert.equal(MIN_SUPPORT, 2);
});
