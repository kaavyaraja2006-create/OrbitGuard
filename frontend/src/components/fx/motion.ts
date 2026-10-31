/** Shared motion vocabulary: one easing curve and a few durations, used everywhere. */
export const EASE = [0.22, 1, 0.36, 1] as const;
export const DUR = { fast: 0.18, base: 0.32, slow: 0.6 } as const;

export const fadeUp = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: DUR.slow, ease: EASE } },
};

export const stagger = (step = 0.06, delay = 0) => ({
  hidden: {},
  show: { transition: { staggerChildren: step, delayChildren: delay } },
});
