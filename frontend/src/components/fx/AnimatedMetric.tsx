import { animate, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * Counts up to a real value when it scrolls into view (and re-animates when it changes).
 * `null` renders an em dash: no value is ever invented.
 */
export function AnimatedMetric({
  value,
  format = (v) => Math.round(v).toLocaleString("en-US"),
  duration = 1.1,
  className = "",
}: {
  value: number | null | undefined;
  format?: (v: number) => string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const reduce = useReducedMotion();
  const from = useRef(0);
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (value === null || value === undefined || Number.isNaN(value)) {
      setShown(null);
      return;
    }
    if (!inView) return;
    if (reduce) {
      setShown(value);
      from.current = value;
      return;
    }
    const c = animate(from.current, value, { duration, ease: [0.22, 1, 0.36, 1], onUpdate: (v) => setShown(v) });
    from.current = value;
    return () => c.stop();
  }, [value, inView, reduce, duration]);
  return (
    <span ref={ref} className={`num ${className}`}>
      {shown === null ? "—" : format(shown)}
    </span>
  );
}
