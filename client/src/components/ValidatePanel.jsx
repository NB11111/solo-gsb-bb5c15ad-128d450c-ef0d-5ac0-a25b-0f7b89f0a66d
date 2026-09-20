import { useState } from "react";
import { validateSample } from "../api";
import { DEFAULT_VALIDATE_SAMPLE } from "../defaultSamples";

const TARGET_META = {
  infer: "按样本归纳出的契约校验",
  variant: "按事件变体契约（oneOf 分支）校验",
};

export default function ValidatePanel({ schema, variantSchema, target = "infer", onTargetChange }) {
  const [text, setText] = useState(DEFAULT_VALIDATE_SAMPLE);
  const [parseError, setParseError] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Fall back to the inferred contract when no variant contract is available.
  const activeTarget = target === "variant" && variantSchema ? "variant" : "infer";
  const activeSchema = activeTarget === "variant" ? variantSchema : schema;

  async function runValidate() {
    setError(null);
    setResult(null);
    let sample;
    try {
      sample = JSON.parse(text);
      setParseError(null);
    } catch (e) {
      setParseError(e.message);
      return;
    }
    setBusy(true);
    try {
      setResult(await validateSample(activeSchema, sample));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!activeSchema) {
    return (
      <div className="empty-hint">
        请先在左侧归纳出 Schema，或在「⑤ 事件变体」生成变体契约，再校验新样本。
      </div>
    );
  }

  return (
    <div className="validate-panel">
      {variantSchema && onTargetChange && (
        <div className="validate-target">
          <span className="panel-label">校验目标</span>
          <div className="perspective-toggle">
            <button
              type="button"
              className={activeTarget === "infer" ? "active" : ""}
              onClick={() => onTargetChange("infer")}
            >
              归纳 Schema
            </button>
            <button
              type="button"
              className={activeTarget === "variant" ? "active" : ""}
              onClick={() => onTargetChange("variant")}
            >
              事件变体契约
            </button>
          </div>
          <span className="panel__meta">{TARGET_META[activeTarget]}</span>
        </div>
      )}

      <div className="validate-panel__editor">
        <div className="panel-label">待校验样本</div>
        <textarea
          className={`code-input ${parseError ? "code-input--err" : ""}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          rows={12}
        />
        {parseError && <div className="parse-error">JSON 解析失败：{parseError}</div>}
        <button type="button" className="btn btn--primary" onClick={runValidate} disabled={busy}>
          {busy ? "校验中…" : "校验样本"}
        </button>
      </div>

      {error && <div className="alert alert--err">{error}</div>}

      {result && (
        <div className="validate-result">
          {result.valid ? (
            <div className="alert alert--ok">✓ 校验通过，样本符合契约。</div>
          ) : (
            <>
              <div className="alert alert--err">✗ 校验失败，共 {result.errors.length} 处问题：</div>
              <ul className="error-list">
                {result.errors.map((e, i) => (
                  <li key={i} className="error-item">
                    <div className="error-item__head">
                      <code className="error-pointer">{e.pointer}</code>
                      <span className="flag flag--keyword">{e.keyword}</span>
                    </div>
                    <div className="error-item__msg">{e.message}</div>
                    {e.params && Object.keys(e.params).length > 0 && (
                      <div className="error-item__params">
                        参数：<code>{JSON.stringify(e.params)}</code>
                      </div>
                    )}
                    <div className="error-item__schema">
                      规则：<code>{e.schemaPath}</code>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
