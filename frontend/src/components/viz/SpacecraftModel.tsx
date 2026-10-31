import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SpacecraftConfig } from "../../types/mission";

const AXIS = { R: "#4DA3FF", T: "#A78BFA", N: "#35D39A" } as const;
const THRUSTER: Record<string, string> = { "cold-gas": "#9AAAC0", monoprop: "#F5B942", "green-monoprop": "#35D39A", biprop: "#FF9F43", hall: "#A78BFA" };

function textSprite(text: string, color: string) {
  const cv = document.createElement("canvas");
  cv.width = 128;
  cv.height = 64;
  const g = cv.getContext("2d")!;
  g.font = "700 40px 'JetBrains Mono Variable', monospace";
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = color;
  g.shadowBlur = 8;
  g.fillText(text, 64, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.set(0.62, 0.31, 1);
  return s;
}

/**
 * Schematic 3D model of the digital twin. Proportions follow the configured dry mass (bus size)
 * and cross-section area (solar wings); the arrows are the RTN burn directions the attitude
 * system allows (+R radial, +T along-track, +N orbit normal). Not a CAD model of a real spacecraft.
 */
export function SpacecraftModel({ config, className = "" }: { config: SpacecraftConfig; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, el.clientWidth / el.clientHeight, 0.05, 200);
    camera.position.set(5.2, 3.2, 6.2);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = !reduce;
    controls.autoRotateSpeed = 0.8;
    controls.minDistance = 3;
    controls.maxDistance = 16;
    controls.enablePan = false;

    // lights: sun, cool rim, soft fill
    scene.add(new THREE.AmbientLight(0x8ea4cf, 0.9));
    scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x0b1a2e, 0.6));
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.4);
    sun.position.set(6, 5, 3);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x36d6e8, 1.1);
    rim.position.set(-5, -2, -4);
    scene.add(rim);

    // faint stars
    const starGeo = new THREE.BufferGeometry();
    const sp: number[] = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 500; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      sp.push(60 * r * Math.cos(th), 60 * r * Math.sin(th), 60 * u);
    }
    starGeo.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcfe0ff, size: 0.12, transparent: true, opacity: 0.7 })));

    // ---- spacecraft (body frame: x = +T along-track, y = +R radial, z = +N normal)
    const craft = new THREE.Group();
    scene.add(craft);
    const bus = Math.min(2.2, Math.max(0.7, Math.cbrt(config.structure.dry_mass_kg / 120)));
    const foil = new THREE.MeshStandardMaterial({ color: 0xe0b84a, metalness: 0.7, roughness: 0.28, emissive: 0x3a2808 });
    const silver = new THREE.MeshStandardMaterial({ color: 0xc8d3e3, metalness: 0.9, roughness: 0.25 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(bus * 1.15, bus, bus), foil);
    craft.add(body);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: 0x3a2f12 }));
    craft.add(edges);
    // radiator panel
    const rad = new THREE.Mesh(new THREE.BoxGeometry(bus * 0.9, 0.02, bus * 0.8), new THREE.MeshStandardMaterial({ color: 0xe8eef7, metalness: 0.2, roughness: 0.5 }));
    rad.position.y = -bus / 2 - 0.011;
    craft.add(rad);

    // solar wings along ±N, sized from the cross-section area
    const wingArea = Math.max(0.6, config.structure.area_m2 * 0.9);
    const ww = Math.min(4.5, Math.sqrt(wingArea * 2)), wh = Math.min(2, ww / 2.2);
    const cellMat = new THREE.MeshStandardMaterial({ color: 0x14306b, metalness: 0.6, roughness: 0.25, emissive: 0x06122a });
    for (const s of [-1, 1]) {
      const yoke = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5), silver);
      yoke.rotation.x = Math.PI / 2;
      yoke.position.z = s * (bus / 2 + 0.25);
      craft.add(yoke);
      const wing = new THREE.Group();
      wing.position.z = s * (bus / 2 + 0.5 + ww / 2);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(wh, 0.03, ww), silver);
      wing.add(frame);
      const nx = 3, nz = Math.max(3, Math.round(ww / 0.45));
      for (let i = 0; i < nx; i++)
        for (let k = 0; k < nz; k++) {
          const c = new THREE.Mesh(new THREE.BoxGeometry(wh / nx - 0.03, 0.035, ww / nz - 0.03), cellMat);
          c.position.set(-wh / 2 + (i + 0.5) * (wh / nx), 0.004, -ww / 2 + (k + 0.5) * (ww / nz));
          wing.add(c);
        }
      wing.rotation.z = 0.12;
      craft.add(wing);
    }

    // antenna dish on +R (Earth-facing would be -R; this is a schematic high-gain antenna)
    const dishPts = Array.from({ length: 12 }, (_, i) => new THREE.Vector2((i / 11) * bus * 0.42, ((i / 11) ** 2) * bus * 0.16));
    const dish = new THREE.Mesh(new THREE.LatheGeometry(dishPts, 32), new THREE.MeshStandardMaterial({ color: 0xe8eef7, metalness: 0.3, roughness: 0.4, side: THREE.DoubleSide }));
    dish.position.y = bus / 2 + 0.05;
    craft.add(dish);

    // thruster on the aft face (-T), plume points backwards
    const tColor = new THREE.Color(THRUSTER[config.propulsion.kind] ?? "#F5B942");
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.08, bus * 0.16, bus * 0.3, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0x8a96a8, metalness: 0.9, roughness: 0.3, side: THREE.DoubleSide }));
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.x = -(bus * 1.15) / 2 - bus * 0.15;
    craft.add(nozzle);
    const plume = new THREE.Mesh(
      new THREE.ConeGeometry(bus * 0.15, bus * 1.1, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: tColor, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    plume.rotation.z = Math.PI / 2;
    plume.position.x = nozzle.position.x - bus * 0.7;
    craft.add(plume);

    // RTN burn-direction arrows: bright if allowed, faint if not
    const allowed = new Set(config.attitude.allowed_directions);
    const L = bus * 1.15 + 1.1;
    const dirs: [string, THREE.Vector3, string][] = [
      ["+T", new THREE.Vector3(1, 0, 0), AXIS.T], ["-T", new THREE.Vector3(-1, 0, 0), AXIS.T],
      ["+R", new THREE.Vector3(0, 1, 0), AXIS.R], ["-R", new THREE.Vector3(0, -1, 0), AXIS.R],
      ["+N", new THREE.Vector3(0, 0, 1), AXIS.N], ["-N", new THREE.Vector3(0, 0, -1), AXIS.N],
    ];
    for (const [name, v, c] of dirs) {
      const on = allowed.has(name);
      const len = name.endsWith("N") ? L + ww * 0.5 : L;
      const arrow = new THREE.ArrowHelper(v, new THREE.Vector3(0, 0, 0), len, new THREE.Color(c), 0.22, 0.12);
      (arrow.line.material as THREE.LineBasicMaterial).transparent = true;
      (arrow.line.material as THREE.LineBasicMaterial).opacity = on ? 0.95 : 0.15;
      (arrow.cone.material as THREE.MeshBasicMaterial).transparent = true;
      (arrow.cone.material as THREE.MeshBasicMaterial).opacity = on ? 0.95 : 0.15;
      craft.add(arrow);
      if (on) {
        const lab = textSprite(name, c);
        lab.position.copy(v.clone().multiplyScalar(len + 0.3));
        craft.add(lab);
      }
    }

    // ---- loop
    let raf = 0, visible = true;
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(el);
    const t0 = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden) return;
      const t = (performance.now() - t0) / 1000;
      (plume.material as THREE.MeshBasicMaterial).opacity = reduce ? 0.3 : 0.25 + 0.12 * Math.sin(t * 9) * Math.sin(t * 3.1);
      if (!reduce) craft.position.y = Math.sin(t * 0.6) * 0.06;
      controls.update();
      renderer.render(scene, camera);
    };
    loop();
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => {
          (x as THREE.SpriteMaterial).map?.dispose?.();
          x.dispose();
        });
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [config]);
  return <div ref={host} className={`relative h-full w-full cursor-grab active:cursor-grabbing ${className}`} aria-label="3D model of the digital twin" role="img" />;
}
