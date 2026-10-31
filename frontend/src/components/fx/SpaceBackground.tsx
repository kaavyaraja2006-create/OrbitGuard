import { useEffect, useRef } from "react";

/**
 * A sparse, slowly twinkling star field on a canvas. Decorative only (aria-hidden).
 * Draws once under prefers-reduced-motion; pauses when off-screen or the tab is hidden.
 */
export function SpaceBackground({ density = 0.00012, parallax = true, className = "" }: { density?: number; parallax?: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0, h = 0, raf = 0, visible = true;
    let mx = 0, my = 0, px = 0, py = 0;
    let stars: { x: number; y: number; r: number; a: number; ph: number; sp: number; z: number; c: string }[] = [];
    let seed = 1337;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = Math.max(1, w * dpr);
      cv.height = Math.max(1, h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed = 1337;
      const n = Math.round(w * h * density);
      stars = Array.from({ length: n }, () => {
        const z = rnd();
        return {
          x: rnd() * w, y: rnd() * h, r: 0.3 + z * 1.1, a: 0.25 + rnd() * 0.6, ph: rnd() * Math.PI * 2, sp: 0.2 + rnd() * 0.8, z,
          c: rnd() < 0.12 ? "180,210,255" : rnd() < 0.06 ? "255,225,190" : "232,238,247",
        };
      });
    };
    const draw = (time: number) => {
      ctx.clearRect(0, 0, w, h);
      px += (mx - px) * 0.04;
      py += (my - py) * 0.04;
      for (const s of stars) {
        const tw = reduce ? 1 : 0.65 + 0.35 * Math.sin(s.ph + time * 0.0006 * s.sp);
        const ox = parallax ? px * s.z * 10 : 0, oy = parallax ? py * s.z * 10 : 0;
        ctx.beginPath();
        ctx.fillStyle = `rgba(${s.c},${s.a * tw})`;
        ctx.arc(s.x + ox, s.y + oy, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const loop = (t: number) => {
      if (visible && !document.hidden) draw(t);
      raf = requestAnimationFrame(loop);
    };
    const onMove = (e: PointerEvent) => {
      mx = e.clientX / window.innerWidth - 0.5;
      my = e.clientY / window.innerHeight - 0.5;
    };
    resize();
    const ro = new ResizeObserver(() => {
      resize();
      if (reduce) draw(0);
    });
    ro.observe(cv);
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(cv);
    if (reduce) draw(0);
    else {
      raf = requestAnimationFrame(loop);
      if (parallax) window.addEventListener("pointermove", onMove, { passive: true });
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
    };
  }, [density, parallax]);
  return <canvas ref={ref} aria-hidden className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} />;
}
