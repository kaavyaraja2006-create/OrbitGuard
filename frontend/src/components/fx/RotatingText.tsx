import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { EASE } from "./motion";

/** Cycles through phrases with a vertical crossfade. Pauses while the tab is hidden. */
export function RotatingText({ phrases, interval = 2800, className = "" }: { phrases: string[]; interval?: number; className?: string }) {
  const [i, setI] = useState(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) setI((k) => (k + 1) % phrases.length);
    }, interval);
    return () => window.clearInterval(id);
  }, [phrases.length, interval]);
  return (
    <span className={`relative inline-grid overflow-hidden ${className}`} aria-live="polite">
      {/* reserve the width of the longest phrase so nothing shifts */}
      <span className="invisible col-start-1 row-start-1" aria-hidden>
        {phrases.reduce((a, b) => (b.length > a.length ? b : a), "")}
      </span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={i}
          className="col-start-1 row-start-1"
          initial={reduce ? { opacity: 0 } : { y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { y: "-100%", opacity: 0 }}
          transition={{ duration: 0.55, ease: EASE }}
        >
          {phrases[i]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
