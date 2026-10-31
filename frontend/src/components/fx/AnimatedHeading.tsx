import { motion, useReducedMotion } from "motion/react";
import type { ElementType } from "react";
import { EASE } from "./motion";

/**
 * Word-by-word entrance: each word rises and fades in. Words listed in `emphasis`
 * get the slow gradient treatment. Respects prefers-reduced-motion.
 */
export function AnimatedHeading({
  text,
  as: Tag = "h1",
  emphasis = [],
  className = "",
  delay = 0,
  step = 0.07,
}: {
  text: string;
  as?: ElementType;
  emphasis?: string[];
  className?: string;
  delay?: number;
  step?: number;
}) {
  const reduce = useReducedMotion();
  const words = text.split(" ");
  const emph = new Set(emphasis.map((w) => w.toUpperCase()));
  return (
    <Tag className={className} aria-label={text}>
      {words.map((w, i) => {
        const bare = w.replace(/[.,!?]/g, "").toUpperCase();
        return (
          <span key={i} aria-hidden className="inline-block overflow-hidden pb-[0.08em] align-bottom">
            <motion.span
              className={`inline-block ${emph.has(bare) ? "text-gradient" : ""}`}
              initial={reduce ? false : { y: "105%", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.75, ease: EASE, delay: delay + i * step }}
            >
              {w}
            </motion.span>
            {i < words.length - 1 && " "}
          </span>
        );
      })}
    </Tag>
  );
}
