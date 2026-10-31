import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Info } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Panel } from "../ui";
import { EASE } from "./motion";

/**
 * Panel with an accent hairline, an optional eyebrow and an expandable
 * "technical details" drawer for the method, frame, units and assumptions behind the numbers.
 */
export function ScientificCard({
  title,
  subtitle,
  actions,
  children,
  details,
  accent,
  className = "",
  bodyClassName,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  details?: ReactNode;
  accent?: string;
  className?: string;
  bodyClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Panel title={title} subtitle={subtitle} actions={actions} className={`panel-glow overflow-hidden ${className}`} bodyClassName={bodyClassName} accent={accent}>
      {children}
      {details && (
        <div className="mt-3 border-t border-line-2 pt-2">
          <button className="flex items-center gap-1.5 text-[11px] text-ink-2 hover:text-ink" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Info size={12} /> Technical details
            <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease: EASE }} className="overflow-hidden">
                <div className="pt-2 text-[11px] leading-relaxed text-ink-2">{details}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </Panel>
  );
}
