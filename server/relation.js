"use strict";

/**
 * Field relation mining.
 *
 * Given the current samples, field presence sets are tallied inside every
 * object **pointer scope** — one record per concrete object location:
 *
 *   - the root object of every top-level sample is its own scope;
 *   - every element of every array is an INDEPENDENT scope (array objects are
 *     counted per element; sibling elements, different arrays and the array's
 *     parent are never correlated);
 *   - nested objects open their own scope, so relations never cross scope
 *     boundaries.
 *
 * Scope identity is expressed as a SCHEMA JSON Pointer: object keys extend it
 * by "/properties/<key>" and every array boundary by "/items" (so the element
 * objects of `list` live at "/properties/list/items" and a nested object field
 * `x` of those elements at "/properties/list/items/properties/x"). That is
 * collision-free even for exotic key names and directly identifies the schema
 * node later enhanced. Concrete observation paths instead keep real array
 * indexes ("#/0/list/0/x").
 *
 * Within each scope two kinds of rules are mined:
 *
 *   implication ("出现 A 必出现 B"): support = number of object instances in
 *     which A appears >= MIN_SUPPORT, and B is present in EVERY one of them
 *     (confidence 100%).
 *   equivalence ("A / B 必同时出现"): fields reachable both ways form a
 *     strongly connected component (they are observed on exactly the same
 *     instances); a group of N members is emitted as N-1 pairwise equivalence
 *     rules spanning the group.
 *   mutex ("A/B 互斥"): both fields appear in at least MIN_SUPPORT instances,
 *     yet never co-occur in the same instance (confidence 100%).
 *
 * Implication edges are reduced on the condensation DAG of the strongly
 * connected components: an edge A -> B is dropped whenever its component still
 * reaches B's component through other edges, so a chain collapses to its
 * endpoints (the transitive A -> C in A -> B -> C disappears).
 *
 * The enhanced schema applies picked rules with `dependentRequired`
 * (implication / equivalence) and `allOf: [{ not: { required: [...] } }]`
 * (mutex) at the matching object nodes. Every ORIGINAL sample is then
 * re-validated against the enhanced schema with Ajv; a single failure refuses
 * the whole run (422) and no schema is produced.
 */

const Ajv2020 = require("ajv/dist/2020").default;
const { escapePointer } = require("./infer");

const MAX_SAMPLES = 200;
const MIN_SUPPORT = 2;

const ajv = new Ajv2020({ allErrors: true, strict: false });

const clone = (value) => JSON.parse(JSON.stringify(value));

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Concrete sample path: "#/<i>/a/0" (RFC 6901 escaping, real array indexes). */
function samplePath(sampleIndex, pathSegs) {
  if (pathSegs.length === 0) return `#/${sampleIndex}`;
  return `#/${sampleIndex}/${pathSegs.map(escapePointer).join("/")}`;
}

/**
 * Walk every sample and collect one record per concrete object location.
 *
 * `locSegs` builds the SCHEMA pointer ("/properties/<key>" per object field,
 * "/items" per array boundary), `pathSegs` builds the concrete sample path
 * (escaped object keys plus real numeric array indexes).
 *
 * @returns {Map<string, object>} keyed by the JSON form of locSegs
 */
function collectScopes(samples) {
  const scopes = new Map();

  function ensureScope(locSegs, sampleIndex, pathSegs) {
    const key = JSON.stringify(locSegs);
    let scope = scopes.get(key);
    if (!scope) {
      scope = {
        location: locSegs.length === 0 ? "" : `/${locSegs.join("/")}`,
        fields: new Set(), // union of field names ever seen at this location
        paths: [], // concrete sample path of every object instance observed here
        fieldPaths: new Map(), // field -> concrete instance paths carrying it
      };
      scopes.set(key, scope);
    }
    scope.paths.push(samplePath(sampleIndex, pathSegs));
    return scope;
  }

  function walk(value, locSegs, pathSegs, sampleIndex) {
    if (isObject(value)) {
      const scope = ensureScope(locSegs, sampleIndex, pathSegs);
      for (const key of Object.keys(value)) {
        scope.fields.add(key);
        if (!scope.fieldPaths.has(key)) scope.fieldPaths.set(key, []);
        scope.fieldPaths.get(key).push(samplePath(sampleIndex, pathSegs));
        // Nested objects open their own scope below this property.
        walk(
          value[key],
          [...locSegs, "properties", escapePointer(key)],
          [...pathSegs, escapePointer(key)],
          sampleIndex
        );
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        // Every element is an independent instance: the location pointer is
        // shared (a single /items step), the concrete path gains the index.
        walk(item, [...locSegs, "items"], [...pathSegs, String(index)], sampleIndex);
      });
    }
    // Scalars are terminals.
  }

  samples.forEach((sample, index) => walk(sample, [], [], index));
  return scopes;
}

/**
 * Mine implication and mutex candidates in one object scope. Both kinds
 * require support >= MIN_SUPPORT and 100% confidence.
 */
function mineScope(scope) {
  const fields = [...scope.fields].sort();
  const pathSet = new Map(); // field -> Set(instance paths)
  for (const f of fields) pathSet.set(f, new Set(scope.fieldPaths.get(f)));

  const edges = []; // { a, b, support } raw implication edges
  const mutexPairs = []; // { a, b, supportA, supportB }

  for (const a of fields) {
    const aPaths = pathSet.get(a);
    if (aPaths.size < MIN_SUPPORT) continue;
    for (const b of fields) {
      if (a === b) continue;
      const bPaths = pathSet.get(b);
      let co = 0;
      for (const p of aPaths) if (bPaths.has(p)) co += 1;
      // Implication: every instance carrying A also carries B.
      if (co === aPaths.size) edges.push({ a, b, support: aPaths.size });
      // Mutex: each side observed at least MIN_SUPPORT times, never together.
      if (a < b && bPaths.size >= MIN_SUPPORT && co === 0) {
        mutexPairs.push({ a, b, supportA: aPaths.size, supportB: bPaths.size });
      }
    }
  }

  return { edges, mutexPairs };
}

/**
 * Tarjan strongly connected components over the raw implication edges.
 * Every SCC of size >= 2 is a set of fields observed on exactly the same
 * instances (100%-confidence implication is transitive, so reachability both
 * ways forces identical presence sets): one equivalence group.
 *
 * @returns {{ componentOf: Map<string, number>, components: string[][] }}
 */
function findSccs(edges, fields) {
  const adjacency = new Map();
  for (const field of fields) adjacency.set(field, []);
  for (const { a, b } of edges) adjacency.get(a).push(b);

  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];

  function strongConnect(v) {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v)) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      component.sort();
      components.push(component);
    }
  }

  for (const field of fields) {
    if (!indices.has(field)) strongConnect(field);
  }
  // Deterministic component order (by smallest member, then discovery).
  components.sort((c1, c2) => (c1[0] < c2[0] ? -1 : c1[0] > c2[0] ? 1 : 0));
  const componentOf = new Map();
  components.forEach((component, id) => {
    for (const field of component) componentOf.set(field, id);
  });
  return { componentOf, components };
}

/**
 * Build the reduced set of rules for one scope from its raw implication
 * edges: equivalence rules for SCC members (a spanning chain of pairwise
 * equivalences — minimal yet it forces the whole group to co-occur) and one
 * representative implication per surviving edge of the condensation DAG
 * (its own transitive reduction).
 *
 * @returns {{ equivalences: Array<[string, string]>, implications: Array<{a:string,b:string}> }}
 */
function reduceScope(edges, fields) {
  const { componentOf, components } = findSccs(edges, fields);

  // Spanning chain inside every multi-field SCC: (m0,m1),(m1,m2),...
  const equivalences = [];
  for (const component of components) {
    if (component.length < 2) continue;
    for (let i = 0; i + 1 < component.length; i += 1) {
      equivalences.push([component[i], component[i + 1]]);
    }
  }

  // Condensation graph (component -> component), choose one deterministic
  // representative field edge per condensation adjacency.
  const condAdj = new Map(); // from -> Map(to -> { a, b })
  for (const { a, b } of edges) {
    const ca = componentOf.get(a);
    const cb = componentOf.get(b);
    if (ca === cb) continue;
    if (!condAdj.has(ca)) condAdj.set(ca, new Map());
    const reps = condAdj.get(ca);
    const prev = reps.get(cb);
    if (!prev || a < prev.a || (a === prev.a && b < prev.b)) {
      reps.set(cb, { a, b });
    }
  }

  // Transitive reduction on the condensation DAG: a direct adjacency is
  // redundant when its source still reaches its target around it.
  const nodeIds = components.map((_, id) => id);
  const implications = [];
  for (const ca of nodeIds) {
    for (const [cb, rep] of condAdj.get(ca) || []) {
      const reachableAround = (() => {
        const seen = new Set([ca]);
        const queue = [ca];
        while (queue.length > 0) {
          const node = queue.shift();
          for (const next of condAdj.get(node)?.keys() || []) {
            // Skip the very edge whose redundancy is being decided.
            if (node === ca && next === cb) continue;
            if (next === cb) return true;
            if (!seen.has(next)) {
              seen.add(next);
              queue.push(next);
            }
          }
        }
        return false;
      })();
      if (!reachableAround) implications.push(rep);
    }
  }
  implications.sort((e1, e2) =>
    e1.a === e2.a ? (e1.b < e2.b ? -1 : e1.b > e2.b ? 1 : 0) : e1.a < e2.a ? -1 : 1
  );
  equivalences.sort((p1, p2) => (p1[0] === p2[0] ? (p1[1] < p2[1] ? -1 : 1) : p1[0] < p2[0] ? -1 : 1));
  return { equivalences, implications };
}

function describeRule(kind, a, b) {
  if (kind === "implication") return `出现 ${a} 必出现 ${b}`;
  if (kind === "equivalence") return `${a} 与 ${b} 必同时出现`;
  return `${a} / ${b} 互斥`;
}

function intersection(xs, ys) {
  const set = new Set(ys);
  return xs.filter((x) => set.has(x));
}

function uniqueSampleIndexes(paths) {
  const indexes = new Set();
  for (const p of paths) {
    const m = /^#\/(\d+)/.exec(p);
    if (m) indexes.add(Number(m[1]));
  }
  return [...indexes].sort((x, y) => x - y);
}

/** Assemble the serializable rule object handed to the UI. */
function makeRule({ kind, location, a, b, support, supportA, supportB, scope }) {
  const aPaths = scope.fieldPaths.get(a) || [];
  const bPaths = scope.fieldPaths.get(b) || [];
  const bothPaths = intersection(aPaths, bPaths);
  const sampleIndexes = uniqueSampleIndexes([...aPaths, ...bPaths]);
  return {
    kind, // "implication" | "equivalence" | "mutex"
    location, // object scope pointer ("" = root, "[]" marks an array boundary)
    a,
    b,
    description: describeRule(kind, a, b),
    support, // implication/equivalence: instances with a (== both for equivalence);
    // mutex: min(instances with a, instances with b)
    supportA,
    supportB,
    occurrences: scope.paths.length, // total object instances at this scope
    confidence: 1, // every mined rule holds for 100% of observations
    sampleIndexes,
    observationPaths: {
      scope: scope.paths,
      a: aPaths,
      b: bPaths,
      both: bothPaths,
    },
  };
}

/**
 * Mine field relations across all object pointer scopes of the samples.
 *
 * @param {any[]} samples
 * @returns {{ sampleCount: number, scopeCount: number, minSupport: number,
 *            summary: { implication: number, equivalence: number, mutex: number },
 *            rules: object[] }}
 */
function mineRelations(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'samples' array."), {
      status: 400,
    });
  }
  if (samples.length > MAX_SAMPLES) {
    throw Object.assign(
      new Error(
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per mining.`
      ),
      { status: 400 }
    );
  }

  const scopes = collectScopes(samples);
  const rules = [];

  for (const scope of scopes.values()) {
    const { edges, mutexPairs } = mineScope(scope);
    const { equivalences, implications } = reduceScope(edges, [...scope.fields].sort());

    for (const [a, b] of equivalences) {
      const support = intersection(scope.fieldPaths.get(a), scope.fieldPaths.get(b)).length;
      rules.push(makeRule({ kind: "equivalence", location: scope.location, a, b, support, scope }));
    }
    for (const { a, b } of implications) {
      rules.push(
        makeRule({
          kind: "implication",
          location: scope.location,
          a,
          b,
          support: scope.fieldPaths.get(a).length,
          scope,
        })
      );
    }

    for (const pair of mutexPairs) {
      rules.push(
        makeRule({
          kind: "mutex",
          location: scope.location,
          a: pair.a,
          b: pair.b,
          support: Math.min(pair.supportA, pair.supportB),
          supportA: pair.supportA,
          supportB: pair.supportB,
          scope,
        })
      );
    }
  }

  // Deterministic ordering: scope location, kind, then field names.
  const kindOrder = { implication: 0, equivalence: 1, mutex: 2 };
  rules.sort((r1, r2) => {
    if (r1.location !== r2.location) return r1.location < r2.location ? -1 : 1;
    if (r1.kind !== r2.kind) return kindOrder[r1.kind] - kindOrder[r2.kind];
    if (r1.a !== r2.a) return r1.a < r2.a ? -1 : 1;
    return r1.b < r2.b ? -1 : r1.b > r2.b ? 1 : 0;
  });
  rules.forEach((rule, i) => {
    rule.id = `r${i + 1}`;
  });

  const summary = { implication: 0, equivalence: 0, mutex: 0 };
  for (const rule of rules) summary[rule.kind] += 1;

  return {
    sampleCount: samples.length,
    scopeCount: scopes.size,
    minSupport: MIN_SUPPORT,
    summary,
    rules,
  };
}

/**
 * Re-validate every original sample against the candidate enhanced schema
 * with Ajv; returns Ajv error details keyed by sample index.
 */
function validateAll(enhanced, samples) {
  let validate;
  try {
    validate = ajv.compile(enhanced);
  } catch (err) {
    throw Object.assign(new Error(`Invalid schema: ${err.message}`), { status: 422 });
  }
  const failures = [];
  samples.forEach((sample, index) => {
    if (!validate(sample)) {
      failures.push({ index, errors: mapErrors(validate) });
    }
  });
  return failures;
}

/**
 * Apply selected mined rules onto a schema and re-validate every original
 * sample with Ajv. No schema is returned when any sample fails verification.
 *
 * @param {{ schema: object, samples: any[], ruleIds: string[] }} input
 * @returns {{ schema: object, sampleCount: number, ruleCount: number,
 *            appliedRules: object[], skipped: object[] }}
 */
function buildEnhancedSchema({ schema, samples, ruleIds }) {
  if (!isObject(schema)) {
    throw Object.assign(new Error("Request body must contain a 'schema' object."), {
      status: 400,
    });
  }
  if (!Array.isArray(samples) || samples.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'samples' array."), {
      status: 400,
    });
  }
  if (samples.length > MAX_SAMPLES) {
    throw Object.assign(
      new Error(
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per enhancement.`
      ),
      { status: 400 }
    );
  }
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'ruleIds' array."), {
      status: 400,
    });
  }

  // Re-mine from the original samples: rule payloads from the client are
  // never trusted, ids must correspond to rules the data actually supports.
  const mined = mineRelations(samples);
  const rulesById = new Map(mined.rules.map((rule) => [rule.id, rule]));

  const invalidRules = [];
  const picked = [];
  const seen = new Set();
  ruleIds.forEach((id, index) => {
    if (typeof id !== "string" || !rulesById.has(id)) {
      invalidRules.push({ index, ruleId: String(id), reason: "规则不存在或已失效，请重新挖掘后再选择" });
      return;
    }
    if (!seen.has(id)) {
      seen.add(id);
      picked.push(rulesById.get(id));
    }
  });
  if (invalidRules.length > 0) {
    throw Object.assign(new Error("部分勾选规则无效，未生成增强 Schema。"), {
      status: 400,
      details: { invalidRules },
    });
  }

  const { schema: enhanced, skipped } = applyRules(schema, picked);
  const failures = validateAll(enhanced, samples);
  if (failures.length > 0) {
    const shown = failures.slice(0, 10).map((f) => `#${f.index}`).join("、");
    const more = failures.length > 10 ? ` 等 ${failures.length} 条` : "";
    throw Object.assign(
      new Error(
        `增强 Schema 未通过全部原样本复验（${failures.length}/${samples.length} 条失败：${shown}${more}），未产出增强 Schema。`
      ),
      { status: 422, details: { failures } }
    );
  }

  return {
    schema: enhanced,
    sampleCount: samples.length,
    ruleCount: picked.length,
    appliedRules: picked.map(({ id, kind, location, a, b, description }) => ({
      id,
      kind,
      location,
      a,
      b,
      description,
    })),
    skipped,
  };
}

/**
 * Inject dependentRequired / not+required constraints at the object nodes
 * addressed by the picked rules. Rules whose fields no longer exist in the
 * supplied schema are skipped (reported, never silently applied).
 *
 * @returns {{ schema: object, skipped: Array<{ id: string, reason: string }> }}
 */
function applyRules(schema, picked) {
  const enhanced = clone(schema);
  const skipped = [];

  const byLocation = new Map();
  for (const rule of picked) {
    if (!byLocation.has(rule.location)) byLocation.set(rule.location, []);
    byLocation.get(rule.location).push(rule);
  }

  for (const [location, rules] of byLocation) {
    const node = resolveSchemaNode(enhanced, location);
    if (!node || !isObject(node) || !isObject(node.properties)) {
      for (const rule of rules) {
        skipped.push({ id: rule.id, reason: "作用域不是当前 Schema 中的对象节点" });
      }
      continue;
    }

    const mutexClauses = [];
    for (const rule of rules) {
      const hasA = Object.prototype.hasOwnProperty.call(node.properties, rule.a);
      const hasB = Object.prototype.hasOwnProperty.call(node.properties, rule.b);
      if (!hasA || !hasB) {
        skipped.push({
          id: rule.id,
          reason: `字段 ${!hasA ? rule.a : rule.b} 不在当前 Schema 中`,
        });
        continue;
      }

      if (rule.kind === "implication") {
        // dependentRequired: { a: [b] } — an instance carrying a must carry b.
        addDependentRequired(node, rule.a, rule.b);
      } else if (rule.kind === "equivalence") {
        addDependentRequired(node, rule.a, rule.b);
        addDependentRequired(node, rule.b, rule.a);
      } else {
        // mutex: forbid an instance carrying both fields at once.
        mutexClauses.push({ not: { required: [rule.a, rule.b] } });
      }
    }

    if (mutexClauses.length > 0) {
      if (!Array.isArray(node.allOf)) node.allOf = [];
      node.allOf.push(...mutexClauses);
    }
    sortDependentRequired(node);
  }

  return { schema: enhanced, skipped };
}

function addDependentRequired(node, property, dependency) {
  if (!isObject(node.dependentRequired)) node.dependentRequired = {};
  const deps = new Set(node.dependentRequired[property] || []);
  deps.add(dependency);
  node.dependentRequired[property] = [...deps].sort();
}

function sortDependentRequired(node) {
  if (!isObject(node.dependentRequired)) return;
  const sorted = {};
  for (const key of Object.keys(node.dependentRequired).sort()) {
    sorted[key] = node.dependentRequired[key];
  }
  node.dependentRequired = sorted;
}

/**
 * Walk a schema along a scope location (a schema JSON Pointer: "" root,
 * "/properties/<key>" per object field, "/items" per array boundary) and
 * return the target node or null.
 */
function resolveSchemaNode(schema, location) {
  const segments =
    location === ""
      ? []
      : location
          .slice(1)
          .split("/")
          .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = schema;
  for (let i = 0; i < segments.length;) {
    if (!isObject(node)) return null;
    if (
      segments[i] === "properties" &&
      i + 1 < segments.length &&
      isObject(node.properties)
    ) {
      const key = segments[i + 1];
      if (!Object.prototype.hasOwnProperty.call(node.properties, key)) return null;
      node = node.properties[key];
      i += 2;
    } else if (segments[i] === "items") {
      if (!isObject(node.items)) return null;
      node = node.items;
      i += 1;
    } else {
      return null;
    }
  }
  return node;
}

function mapErrors(validate) {
  return (validate.errors || []).map((e) => ({
    path: e.instancePath || "",
    pointer: e.instancePath || "(root)",
    schemaPath: e.schemaPath,
    keyword: e.keyword,
    message: e.message,
    params: e.params,
  }));
}

module.exports = {
  mineRelations,
  buildEnhancedSchema,
  collectScopes,
  findSccs,
  reduceScope,
  applyRules,
  resolveSchemaNode,
  MAX_SAMPLES,
  MIN_SUPPORT,
};
