"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useAppearance } from "./AppearanceProvider";
import { DensityOptions, THEME_OPTIONS, ThemeOptions } from "./AppearanceControls";

/** Top-bar button that opens the theme choice, plus table density on HR screens. */
export default function AppearanceMenu({ showDensity = false }: { showDensity?: boolean }) {
  const { pref } = useAppearance();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  const current = THEME_OPTIONS.find((o) => o.value === pref) ?? THEME_OPTIONS[2];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={buttonRef}
        id="topnav-appearance-btn"
        type="button"
        aria-label={`Appearance, theme ${current.label}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
          open ? "bg-on-surface/[0.06] text-on-surface" : "text-on-surface-variant hover:bg-on-surface/[0.04] hover:text-on-surface"
        }`}
      >
        <current.icon className="h-[19px] w-[19px]" strokeWidth={1.75} aria-hidden="true" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Appearance"
            initial={reduce ? false : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 z-[70] mt-2 flex w-[min(260px,calc(100vw-2rem))] origin-top-right flex-col gap-3 rounded-2xl bg-surface p-2 pt-3 shadow-float"
          >
            <ThemeOptions layout="list" />
            {showDensity && (
              <div className="border-t border-line pt-3">
                <DensityOptions layout="list" />
                <p className="px-3 pt-1 pb-1 text-xs text-ink-muted">Compact applies on screens 768 px and wider.</p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
