import { useEffect, useRef, useState } from "react";
import { backend } from "@backend";
import { loadSettings } from "../core/settings";
import { modules } from "../modules/registry";
import type { QuickAddTarget } from "../modules/types";

const targets: QuickAddTarget[] = modules.flatMap((m) => m.quickAdd ?? []);

/** The popup opened by the global shortcut. Tab switches target, Enter saves, Esc closes. */
export function QuickAdd() {
  const [idx, setIdx] = useState(0);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const target = targets[idx];

  useEffect(() => {
    const onFocus = () => {
      loadSettings();
      setStatus(null);
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("focus", onFocus);
    onFocus();
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const close = () => backend.hideQuickAdd();

  const save = async () => {
    if (!text.trim()) return;
    try {
      await target.add(text);
      setText("");
      setStatus({ text: `Added to ${target.label.toLowerCase()}s ✓` });
      setTimeout(close, 450);
    } catch (e) {
      setStatus({ text: String((e as Error)?.message ?? e), error: true });
    }
  };

  const preview = text.trim() ? target.preview?.(text) : null;

  return (
    <div
      className="quickadd"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
        if (e.key === "Tab") {
          e.preventDefault();
          setIdx((i) => (i + (e.shiftKey ? targets.length - 1 : 1)) % targets.length);
        }
      }}
    >
      <div className="quickadd-tabs" role="tablist">
        {targets.map((t, i) => (
          <button key={t.id} role="tab" aria-selected={i === idx} className={"qa-tab" + (i === idx ? " active" : "")} onClick={() => { setIdx(i); input.current?.focus(); }}>
            {t.label}
          </button>
        ))}
        <span className="muted small qa-keys">Tab switch · Enter add · Esc close</span>
      </div>
      <input
        ref={input}
        className="quickadd-input"
        value={text}
        placeholder={target.placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setStatus(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && save()}
        aria-label={target.label}
      />
      <div className={"quickadd-foot" + (status?.error ? " error" : status ? " ok" : "")}>{status?.text ?? preview ?? target.hint ?? ""}</div>
    </div>
  );
}
