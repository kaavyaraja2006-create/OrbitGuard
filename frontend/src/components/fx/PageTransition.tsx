import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { EASE } from "./motion";

/** Route-level entrance: a short fade and 8 px rise. Keyed by the router, so it plays per page. */
export function PageTransition({ children, className = "" }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.38, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
