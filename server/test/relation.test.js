"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inferSchema } = require("../infer");
const {
  mineRelations,
  buildEnhancedSchema,
  collectScopes,
  MAX_SAMPLES,
  MIN_SUPPORT,
} = require("../relation");

test("mineRelations reports summary, scope count and 100% confidence", () => {
  const samples = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  const out = mineRelations(samples);
  assert.equal(out.sampleCount, 2);
  assert.equal(out.minSupport, MIN_SUPPORT);
  assert.equal(out.scopeCount, 1);
  assert.equal(out.summary.implication + out.summary.equivalence + out.summary.mutex, out.rules.length);
  for (const rule of out.rules) assert.equal(rule.confidence, 1);
});

test("mineRelations finds a mutex pair that never co-occurs", () => {
  const samples = [{ phone: "1" }, { email: "e" }, { phone: "2" }, { email: "f" }];
  const out = mineRelations(samples);
  const mutex = out.rules.find((r) => r.kind === "mutex" && r.a === "email" && r.b === "phone");
  assert.ok(mutex, "expected an email/phone mutex rule");
  assert.equal(mutex.location, "");
  assert.equal(mutex.supportA, 2);
  assert.equal(mutex.supportB, 2);
  assert.equal(mutex.support, 2);
  assert.deepEqual(mutex.observationPaths.both, []);
  assert.deepEqual(mutex.sampleIndexes.sort((x, y) => x - y), [0, 1, 2, 3]);
});

test("mineRelations finds an implication: A appears => B always appears", () => {
  const samples = [{ a: 1, b: 1 }, { a: 2, b: 2 }, { b: 3 }];
  const out = mineRelations(samples);
  const imp = out.rules.find((r) => r.kind === "implication" && r.a === "a" && r.b === "b");
  assert.ok(imp, "expected a -> b");
  assert.equal(imp.support, 2);
  assert.equal(imp.occurrences, 3);
  // The reverse (b -> a) must not be mined: b appears without a once.
  assert.equal(
    out.rules.some((r) => (r.kind === "implication" || r.kind === "equivalence") && r.a === "b" && r.b === "a"),
    false
  );
});

test("mineRelations requires support >= 2: a single observation is not a rule", () => {
  const samples = [{ a: 1, b: 1 }, { c: 2 }, { c: 3 }];
  const out = mineRelations(samples);
  // a/b co-occur only once -> no rule; c alone -> no pair.
  assert.equal(out.rules.length, 0);
});

test("mineRelations merges an A<->B pair into one equivalence rule", () => {
  const samples = [
    { a: 1, b: 1, c: 9 },
    { a: 2, b: 2 },
    { c: 3 },
  ];
  const out = mineRelations(samples);
  const eq = out.rules.find((r) => r.kind === "equivalence");
  assert.ok(eq);
  assert.equal(eq.a, "a");
  assert.equal(eq.b, "b");
  assert.equal(eq.support, 2);
  // No separate a->b / b->a implications survive.
  assert.equal(out.rules.some((r) => r.kind === "implication"), false);
});

test("mineRelations collapses a larger co-occurrence SCC into a spanning chain", () => {
  const samples = [
    { x: 1, y: 1, z: 1 },
    { x: 2, y: 2, z: 2 },
    { q: 1 },
  ];
  const out = mineRelations(samples);
  const eqs = out.rules.filter((r) => r.kind === "equivalence");
  assert.deepEqual(
    eqs.map((r) => [r.a, r.b]),
    [
      ["x", "y"],
      ["y", "z"],
    ]
  );
});

test("mineRelations transitively reduces a strict chain a->b->c", () => {
  const samples = [{ a: 1, b: 1, c: 1 }, { a: 2, b: 2, c: 2 }, { b: 3, c: 3 }, { c: 4 }];
  const out = mineRelations(samples);
  const edges = out.rules
    .filter((r) => r.kind === "implication")
    .map((r) => `${r.a}->${r.b}`);
  assert.ok(edges.includes("a->b"));
  assert.ok(edges.includes("b->c"));
  assert.ok(!edges.includes("a->c"), "a->c is implied transitively and must be reduced away");
});

test("mineRelations counts array elements independently, never across scopes", () => {
  // One array whose three elements carry disjoint field patterns: element
  // instances are independent scopes, so the single (a,b) co-occurrence here
  // must not correlate with the sibling element or with the parent object.
  const samples = [{ id: 1, list: [{ a: 1, b: 1 }, { a: 2 }, { b: 3 }] }];
  const scopes = collectScopes(samples);
  const elementScope = [...scopes.values()].find((s) => s.location === "/properties/list/items");
  assert.ok(elementScope);
  assert.deepEqual(elementScope.paths, ["#/0/list/0", "#/0/list/1", "#/0/list/2"]);
  assert.deepEqual(elementScope.fieldPaths.get("a"), ["#/0/list/0", "#/0/list/1"]);
  assert.deepEqual(elementScope.fieldPaths.get("b"), ["#/0/list/0", "#/0/list/2"]);

  const out = mineRelations(samples);
  // (a,b) co-occurs in only one element -> no implication/equivalence.
  assert.equal(
    out.rules.some((r) => r.location === "/properties/list/items" && r.kind !== "mutex"),
    false
  );
});

test("mineRelations does not correlate across array boundaries", () => {
  // Field `a` on the parent object and `a` on array elements are different
  // scopes: they must never be compared even though names coincide.
  const samples = [
    { a: 1, list: [{ b: 1 }] },
    { a: 2, list: [{ b: 2 }, { c: 3 }] },
  ];
  const out = mineRelations(samples);
  // No rule at root mixes `a` with anything from inside the array elements.
  for (const rule of out.rules) {
    if (rule.location === "") {
      assert.ok(!["b", "c"].includes(rule.a));
      assert.ok(!["b", "c"].includes(rule.b));
    }
  }
});

test("mineRelations aggregates the same array-element location across samples", () => {
  const samples = [
    { list: [{ x: 1, y: 1 }] },
    { list: [{ x: 2, y: 2 }, { x: 3, y: 3 }] },
  ];
  const out = mineRelations(samples);
  const eq = out.rules.find(
    (r) => r.kind === "equivalence" && r.location === "/properties/list/items" && r.a === "x" && r.b === "y"
  );
  assert.ok(eq, "x/y co-occur in all three element instances across both samples");
  assert.equal(eq.support, 3);
  assert.deepEqual(eq.observationPaths.scope, [
    "#/0/list/0",
    "#/1/list/0",
    "#/1/list/1",
  ]);
});

test("mineRelations mines nested object scopes with concrete observation paths", () => {
  const samples = [
    { addr: { zip: "1", city: "X" } },
    { addr: { zip: "2", city: "Y" } },
  ];
  const out = mineRelations(samples);
  const rule = out.rules.find(
    (r) => r.kind === "equivalence" && r.location === "/properties/addr"
  );
  assert.ok(rule, "city/zip equivalence lives in the nested object scope");
  assert.deepEqual([rule.a, rule.b], ["city", "zip"]);
  // Observation paths point at the nested object instances, one per sample.
  assert.deepEqual(rule.observationPaths.scope, ["#/0/addr", "#/1/addr"]);
  assert.deepEqual(rule.observationPaths.a, ["#/0/addr", "#/1/addr"]);
});

test("buildEnhancedSchema emits dependentRequired for an implication and re-verifies samples", () => {
  const samples = [{ a: 1, b: 1 }, { a: 2, b: 2 }, { b: 3 }];
  const mined = mineRelations(samples);
  const imp = mined.rules.find((r) => r.kind === "implication" && r.a === "a" && r.b === "b");
  const { schema } = inferSchema(samples);

  const out = buildEnhancedSchema({ schema, samples, ruleIds: [imp.id] });
  assert.deepEqual(out.schema.dependentRequired, { a: ["b"] });
  assert.equal(out.ruleCount, 1);
  assert.deepEqual(out.skipped, []);

  const Ajv = require("ajv/dist/2020").default;
  const validate = new Ajv({ strict: false }).compile(out.schema);
  assert.equal(validate({ a: 9 }), false);
  assert.equal(validate({ a: 9, b: 1 }), true);
  assert.equal(validate({ b: 1 }), true);
});

test("buildEnhancedSchema emits bidirectional dependentRequired for equivalence", () => {
  const samples = [{ a: 1, b: 1, c: 9 }, { a: 2, b: 2 }, { c: 3 }];
  const mined = mineRelations(samples);
  const eq = mined.rules.find((r) => r.kind === "equivalence");
  const { schema } = inferSchema(samples);
  const out = buildEnhancedSchema({ schema, samples, ruleIds: [eq.id] });
  assert.deepEqual(out.schema.dependentRequired, { a: ["b"], b: ["a"] });
});

test("buildEnhancedSchema emits not/required inside allOf for a mutex rule", () => {
  const samples = [{ phone: "1" }, { email: "e" }, { phone: "2" }, { email: "f" }];
  const mined = mineRelations(samples);
  const mutex = mined.rules.find((r) => r.kind === "mutex");
  const { schema } = inferSchema(samples);
  const out = buildEnhancedSchema({ schema, samples, ruleIds: [mutex.id] });
  assert.deepEqual(out.schema.allOf, [{ not: { required: ["email", "phone"] } }]);

  const Ajv = require("ajv/dist/2020").default;
  const validate = new Ajv({ strict: false }).compile(out.schema);
  assert.equal(validate({ phone: "x", email: "y" }), false);
  assert.equal(validate({ phone: "x" }), true);
  assert.equal(validate({ email: "y" }), true);
  assert.equal(validate({}), true);
});

test("buildEnhancedSchema injects constraints inside array items scope", () => {
  const samples = [
    { list: [{ x: 1, y: 1 }] },
    { list: [{ x: 2, y: 2 }, { x: 3, y: 3 }] },
  ];
  const mined = mineRelations(samples);
  const eq = mined.rules.find(
    (r) => r.kind === "equivalence" && r.location === "/properties/list/items"
  );
  const { schema } = inferSchema(samples);
  const out = buildEnhancedSchema({ schema, samples, ruleIds: [eq.id] });
  const items = out.schema.properties.list.items;
  assert.deepEqual(items.dependentRequired, { x: ["y"], y: ["x"] });

  const Ajv = require("ajv/dist/2020").default;
  const validate = new Ajv({ strict: false }).compile(out.schema);
  assert.equal(validate({ list: [{ x: 1 }] }), false);
  assert.equal(validate({ list: [{ x: 1, y: 1 }] }), true);
});

test("buildEnhancedSchema refuses (422) when an original sample fails re-verification", () => {
  const samples = [
    { phone: "x" },
    { email: "y" },
    { phone: "z" },
    { email: "w" },
  ];
  const mined = mineRelations(samples);
  const mutex = mined.rules.find((r) => r.kind === "mutex" && r.a === "email" && r.b === "phone");
  assert.ok(mutex);
  // Hand-supplied schema claims phone is integer; the original string phones
  // therefore fail re-verification and no enhanced schema may be produced.
  const schema = {
    type: "object",
    properties: { phone: { type: "integer" }, email: { type: "string" } },
  };
  assert.throws(
    () => buildEnhancedSchema({ schema, samples, ruleIds: [mutex.id] }),
    (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /未通过全部原样本复验/);
      assert.match(err.message, /未产出增强 Schema/);
      assert.ok(err.details.failures.length >= 1);
      assert.equal(typeof err.details.failures[0].index, "number");
      assert.ok(Array.isArray(err.details.failures[0].errors));
      return true;
    }
  );
});

test("buildEnhancedSchema rejects unknown / stale rule ids with 400", () => {
  const samples = [{ a: 1, b: 1 }, { a: 2, b: 2 }];
  const { schema } = inferSchema(samples);
  assert.throws(
    () => buildEnhancedSchema({ schema, samples, ruleIds: ["r999"] }),
    (err) => err.status === 400 && err.details.invalidRules.length === 1
  );
});

test("buildEnhancedSchema does not mutate the input schema", () => {
  const samples = [{ a: 1, b: 1 }, { a: 2, b: 2 }];
  const mined = mineRelations(samples);
  const { schema } = inferSchema(samples);
  const snapshot = JSON.parse(JSON.stringify(schema));
  buildEnhancedSchema({ schema, samples, ruleIds: [mined.rules[0].id] });
  assert.deepEqual(schema, snapshot);
});

test("buildEnhancedSchema validates its input shape", () => {
  assert.throws(
    () => buildEnhancedSchema({ samples: [{ a: 1 }], ruleIds: ["r1"] }),
    (err) => err.status === 400 && /'schema' object/.test(err.message)
  );
  assert.throws(
    () => buildEnhancedSchema({ schema: {}, ruleIds: ["r1"] }),
    (err) => err.status === 400 && /'samples' array/.test(err.message)
  );
  assert.throws(
    () => buildEnhancedSchema({ schema: {}, samples: [{}] }),
    (err) => err.status === 400 && /'ruleIds' array/.test(err.message)
  );
});

test(`mineRelations caps samples at ${MAX_SAMPLES}`, () => {
  assert.throws(
    () => mineRelations(Array.from({ length: MAX_SAMPLES + 1 }, () => ({ a: 1 }))),
    (err) => err.status === 400 && new RegExp(`${MAX_SAMPLES}`).test(err.message)
  );
  // Exactly at the cap is fine.
  const ok = mineRelations(Array.from({ length: MAX_SAMPLES }, () => ({ a: 1, b: 1 })));
  assert.equal(ok.sampleCount, MAX_SAMPLES);
});

test("mineRelations refuses missing / empty / non-array samples", () => {
  for (const samples of [undefined, null, [], "x", 42]) {
    assert.throws(() => mineRelations(samples), (err) => err.status === 400);
  }
});

test("rules carry observation paths and supporting sample indexes", () => {
  const samples = [{ a: 1, b: 1 }, { a: 2, b: 2 }, { b: 3 }];
  const mined = mineRelations(samples);
  const imp = mined.rules.find((r) => r.kind === "implication" && r.a === "a");
  assert.ok(imp.observationPaths.scope.length === 3);
  assert.deepEqual(imp.observationPaths.a, ["#/0", "#/1"]);
  assert.deepEqual(imp.observationPaths.b, ["#/0", "#/1", "#/2"]);
  assert.deepEqual(imp.sampleIndexes, [0, 1, 2]);
  assert.equal(imp.description, "出现 a 必出现 b");
});

test("rule ids are stable strings and unique", () => {
  const samples = [{ a: 1, b: 1 }, { a: 2, b: 2 }, { phone: 1 }, { email: 2 }];
  const mined = mineRelations(samples);
  const ids = mined.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^r\d+$/.test(id)));
});
