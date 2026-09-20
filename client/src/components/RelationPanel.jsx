import { useState } from "react";
import { mineFieldRelations, buildEnhancedSchema } from "../api.js";

const KIND_META = {
  implication: { label: "出现 A 必出现 B", badge: "rel-badge--imp" },
  equivalence: { label: "A / B 必同时出现", badge: "rel-badge--eq" },
  mutex: { label: "A / B 互斥", badge: "rel-badge--mutex" },
};

/** Human-readable scope location: "(root)" or a Schema Pointer. */
function locationLabel(location) {
  return location === "" ? "(root)" : location;
}

/**
 * Field relation mining panel.
 *
 * The backend tallies field presence inside every object Pointer scope
 * (array elements counted independently) and returns support>=2,
 * 100%-confidence implication / equivalence / mutex candidates, each with
 * its observation paths and supporting samples. The user ticks rules and
 * generates an enhanced schema (dependentRequired + not/required); the
 * backend re-verifies ALL original samples with Ajv and refuses to produce
 * one when any sample fails.
 *
 * Results are keyed by a signature of the sample texts, so any edit
 * invalidates the previous mining/enhancement (same convention as the other
 * panels).
 */
export default function RelationPanel({ schema, samples, allValid, signature, onUseForValidation }) {
  const [busy, setBusy] = useState(false);
  const [mined, setMined] = useState(null); // { signature, data }
  const [mineError, setMineError] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [openRule, setOpenRule] = useState(null);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanced, setEnhanced] = useState(null); // { signature, data }
  const [enhanceError, setEnhanceError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const hasSchema = schema && typeof schema === "object" && !Array.isArray(schema);
  const currentMined = mined && mined.signature === signature ? mined.data : null;
  // Any sample edit changes the signature and invalidates the previous
  // mining/enhancement, matching the other panels' convention.
  const invalidated = mined !== null && mined.signature !== signature;

  const pickedSignature = [...picked].sort().join(",");
  const currentEnhanced =
    enhanced && enhanced.signature === signature && enhanced.ruleSignature === pickedSignature
      ? enhanced.data
      : null;
  // An enhancement exists for these samples but the checkbox selection has
  // since changed: the shown JSON would be stale, so prompt regeneration.
  const selectionChanged =
    enhanced !== null &&
    enhanced.signature === signature &&
    enhanced.ruleSignature !== pickedSignature;

  const pickedArray = [...picked];

  function toggleRule(id) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setEnhanceError(null);
  }

  function selectAll() {
    if (!currentMined) return;
    setPicked(new Set(currentMined.rules.map((r) => r.id)));
    setEnhanceError(null);
  }

  function clearAll() {
    setPicked(new Set());
    setEnhanceError(null);
  }

  async function runMine() {
    setBusy(true);
    setMineError(null);
    setEnhanced(null);
    setEnhanceError(null);
    try {
      const data = await mineFieldRelations(samples);
      setMined({ signature, data });
      setPicked(new Set());
      setOpenRule(null);
    } catch (e) {
      setMined(null);
      setMineError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function runEnhance() {
    if (!hasSchema || picked.size === 0) return;
    setEnhancing(true);
    setEnhanceError(null);
    try {
      const data = await buildEnhancedSchema(schema, samples, pickedArray);
      setEnhanced({ signature, data, ruleSignature: [...picked].sort().join(",") });
      setShowRaw(false);
    } catch (e) {
      setEnhanced(null);
      setEnhanceError(e);
    } finally {
      setEnhancing(false);
    }
  }

  async function copySchema() {
    if (!currentEnhanced) return;
    const text = JSON.stringify(currentEnhanced.schema, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function renderPaths(title, paths) {
    if (!paths || paths.length === 0) return null;
    return (
      <div className="rel-paths">
        <div className="rel-paths__title">
          {title}（{paths.length}）
        </div>
        <ul className="rel-paths__list">
          {paths.map((p) => (
            <li key={p}>
              <code>{p}</code>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="rel-panel">
      <div className="scan-head">
        <span className="panel-label">字段关系挖掘</span>
        <span className="panel__meta">
          在每个对象 Pointer 作用域内统计字段出现集合（数组对象按元素独立计数，禁止跨作用域），找出
          支持数 ≥ 2、置信度 100% 的蕴含 / 互斥候选，蕴含关系已做传递约简
        </span>
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={runMine}
          disabled={busy || !allValid || samples.length === 0}
          title={allValid ? "" : "请先修正无效的 JSON 样本"}
        >
          {busy ? "挖掘中…" : "挖掘字段关系"}
        </button>
        {currentMined && currentMined.rules.length > 0 && (
          <>
            <button type="button" className="btn btn--sm" onClick={selectAll}>
              全选
            </button>
            <button type="button" className="btn btn--sm" onClick={clearAll}>
              清空勾选
            </button>
          </>
        )}
      </div>

      {mineError && <div className="alert alert--err">{mineError}</div>}
      {invalidated && (
        <div className="alert alert--info">样本内容已变化，上次挖掘 / 增强结果已失效，请重新挖掘。</div>
      )}

      {currentMined && (
        <>
          <div className="variant-summary">
            <span className="variant-chip">{currentMined.scopeCount} 个对象作用域</span>
            <span className="variant-chip variant-chip--ok">
              蕴含 {currentMined.summary.implication}
            </span>
            <span className="variant-chip variant-chip--ok">
              同现 {currentMined.summary.equivalence}
            </span>
            <span className="variant-chip variant-chip--ok">
              互斥 {currentMined.summary.mutex}
            </span>
            <span className="panel__meta">
              基于 {currentMined.sampleCount} 份样本 · 阈值 支持数 ≥ {currentMined.minSupport}、置信度 100%
            </span>
          </div>

          {currentMined.rules.length === 0 ? (
            <div className="empty-hint">
              当前样本中没有满足条件的字段关系候选：需要在同一对象作用域内出现至少{" "}
              {currentMined.minSupport} 次且置信度为 100%。可尝试增加样本数量或调整字段出现模式。
            </div>
          ) : (
            <ul className="rel-list">
              {currentMined.rules.map((rule) => {
                const meta = KIND_META[rule.kind];
                const open = openRule === rule.id;
                const checked = picked.has(rule.id);
                return (
                  <li key={rule.id} className={`rel-item rel-item--${rule.kind}`}>
                    <div className="rel-item__head">
                      <input
                        type="checkbox"
                        className="rel-check"
                        checked={checked}
                        onChange={() => toggleRule(rule.id)}
                        title="勾选后加入增强 Schema"
                      />
                      <button
                        type="button"
                        className="rel-item__main"
                        onClick={() => setOpenRule(open ? null : rule.id)}
                        aria-expanded={open}
                      >
                        <span className={`rel-badge ${meta.badge}`}>{meta.label}</span>
                        <code className="rel-item__fields">{rule.description}</code>
                        <span className="rel-item__meta">
                          {rule.kind === "mutex"
                            ? `${rule.supportA}+${rule.supportB} 次 · 0 同现`
                            : `支持 ${rule.support} · 置信度 100%`}
                        </span>
                        <span className="rel-item__scope">
                          作用域 <code>{locationLabel(rule.location)}</code>
                        </span>
                        <span className="scan-item__toggle">{open ? "▲" : "▼"}</span>
                      </button>
                    </div>
                    {open && (
                      <div className="rel-item__detail">
                        <div className="rel-item__samples">
                          支持样本：
                          {rule.sampleIndexes.map((i) => (
                            <span key={i} className="rel-sample-chip">
                              #{i}
                            </span>
                          ))}
                        </div>
                        {renderPaths("作用域观测路径", rule.observationPaths.scope)}
                        {renderPaths(`出现 ${rule.a} 的路径`, rule.observationPaths.a)}
                        {renderPaths(`出现 ${rule.b} 的路径`, rule.observationPaths.b)}
                        {rule.kind !== "mutex" &&
                          renderPaths(`${rule.a} 与 ${rule.b} 同现路径`, rule.observationPaths.both)}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {currentMined.rules.length > 0 && (
            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={runEnhance}
                disabled={enhancing || !hasSchema || picked.size === 0}
                title={
                  !hasSchema
                    ? "请先在「① 样本输入」归纳 Schema"
                    : picked.size === 0
                      ? "请先勾选至少一条规则"
                      : ""
                }
              >
                {enhancing
                  ? "生成复验中…"
                  : `生成增强 Schema（${picked.size} 条规则）`}
              </button>
              {currentEnhanced && (
                <>
                  <button type="button" className="btn" onClick={() => setShowRaw((v) => !v)}>
                    {showRaw ? "隐藏 JSON" : "查看 Schema"}
                  </button>
                  <button type="button" className="btn btn--primary" onClick={copySchema}>
                    {copied ? "✓ 已复制" : "复制增强 Schema"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onUseForValidation?.(currentEnhanced.schema)}
                    title="切换到「③ 校验新样本」并以该增强 Schema 为校验目标"
                  >
                    在校验页验证 →
                  </button>
                </>
              )}
            </div>
          )}

          {selectionChanged && (
            <div className="alert alert--info">勾选规则已变化，下方增强 Schema 为上次结果，请重新生成。</div>
          )}

          {enhanceError && (
            <div className="alert alert--err">
              {enhanceError.message}
              {enhanceError.data && Array.isArray(enhanceError.data.failures) && (
                <div className="slice-failures">
                  {enhanceError.data.failures.map((f) => (
                    <div key={f.index} className="slice-failure">
                      <div className="slice-failure__head">
                        <code className="scan-item__index">样本 {f.index + 1}</code>
                        <span className="ce-badge ce-badge--err">复验失败</span>
                      </div>
                      <ul className="ce-errors">
                        {f.errors.map((e, i) => (
                          <li key={i} className="ce-error">
                            <div className="ce-error__head">
                              <code className="ce-error__pointer">{e.pointer}</code>
                              <span className="ce-badge ce-badge--err">{e.keyword}</span>
                            </div>
                            <div className="ce-error__msg">{e.message}</div>
                            <div className="ce-error__meta">
                              规则路径 <code>{e.schemaPath}</code>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {currentEnhanced && (
            <>
              <div className="variant-summary">
                <span className="variant-chip variant-chip--ok">
                  ✓ 全部 {currentEnhanced.sampleCount} 份原样本复验通过
                </span>
                <span className="variant-chip">已应用 {currentEnhanced.ruleCount} 条规则</span>
                {currentEnhanced.skipped.length > 0 && (
                  <span className="variant-chip variant-chip--skip">
                    跳过 {currentEnhanced.skipped.length} 条
                  </span>
                )}
              </div>
              {currentEnhanced.skipped.length > 0 && (
                <ul className="slice-problem-list">
                  {currentEnhanced.skipped.map((s, i) => (
                    <li key={i}>
                      <code>{s.id}</code>
                      {s.reason}
                    </li>
                  ))}
                </ul>
              )}
              {showRaw && (
                <pre className="schema-raw slice-json">
                  {JSON.stringify(currentEnhanced.schema, null, 2)}
                </pre>
              )}
            </>
          )}
        </>
      )}

      {!currentMined && !invalidated && (
        <div className="empty-hint">
          点击「挖掘字段关系」：后端在每个对象 Pointer 作用域内统计字段出现集合——数组对象按
          元素独立计数，不与兄弟元素或父级关联；随后给出支持数 ≥ 2、置信度 100% 的
          「出现 A 必出现 B」与「A/B 互斥」候选（蕴含已做传递约简），并标注观测路径与支持样本。
        </div>
      )}
    </div>
  );
}
