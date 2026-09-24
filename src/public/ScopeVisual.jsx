import { useEffect, useRef, useState } from 'react';

export default function ScopeVisual() {
  const holder = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = holder.current;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    let release = () => {};
    let loading = false;
    const mount = async () => {
      if (disposed || loading || motion.matches || navigator.connection?.saveData) return;
      loading = true;
      // Probe before importing the renderer. No-WebGL browsers retain the HTML diagram.
      try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2');
        if (!gl) return;
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        const T = await import('./three-pieces.js');
        if (disposed || motion.matches) { loading = false; return; }
        const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.outputColorSpace = T.SRGBColorSpace;
        renderer.setClearColor(0xedf4fc, 0);
        const scene = new T.Scene();
        const camera = new T.PerspectiveCamera(33, 1, .1, 100);
        camera.position.set(6.5, 5.7, 8.6);
        camera.lookAt(0, 0, 0);
        scene.add(new T.AmbientLight(0xffffff, 2.4));
        const light = new T.DirectionalLight(0xffffff, 3.5);
        light.position.set(0, 7, 5);
        scene.add(light);
        const group = new T.Group();
        scene.add(group);
        const resources = [];
        const box = (width, height, depth, color, x, y, z, target = group) => {
          const geometry = new T.BoxGeometry(width, height, depth);
          const material = new T.MeshStandardMaterial({ color, roughness: .32, metalness: .07 });
          const mesh = new T.Mesh(geometry, material);
          mesh.position.set(x, y, z);
          target.add(mesh);
          resources.push(geometry, material);
          return mesh;
        };
        const layers = [new T.Group(), new T.Group(), new T.Group()];
        layers.forEach(layer => group.add(layer));
        // Company foundation, registration surface, and two separately granted branches.
        box(4.5, .17, 3.2, 0x759ed6, 0, 0, 0, layers[0]);
        box(3.8, .14, 2.7, 0xc1d9f8, 0, 0, 0, layers[1]);
        box(1.65, .15, 2.15, 0xf9fcff, -.94, 0, 0, layers[2]);
        box(1.65, .15, 2.15, 0xf9fcff, .94, 0, 0, layers[2]);
        for (const x of [-.94, .94]) {
          box(.34, .06, .34, 0x3e77c9, x - .4, .12, -.6, layers[2]);
          for (let row = 0; row < 3; row++) {
            box(1.05, .035, .07, 0xbdcfea, x, .1, -.03 + row * .25, layers[2]);
          }
        }
        // Registration has its own four record tiles, distinct from branch grants.
        for (const x of [-1.3, -.45, .45, 1.3]) box(.55, .05, .7, 0x8cb3e7, x, .11, .63, layers[1]);
        const posts = [-1.75, 1.75].map(x => box(.022, 2, .022, 0x6b99d3, x, 0, -.75));
        host.appendChild(renderer.domElement);
        renderer.domElement.setAttribute('aria-hidden', 'true');
        let frame = 0;
        let visible = true;
        const draw = () => {
          frame = 0;
          if (!visible || document.hidden || disposed) return;
          const bounds = host.getBoundingClientRect();
          const progress = Math.max(0, Math.min(1, (window.innerHeight - bounds.top) / (window.innerHeight + bounds.height)));
          const separation = .55 + progress * .65;
          layers[0].position.y = -separation;
          layers[1].position.y = 0;
          layers[2].position.y = separation;
          layers[2].position.x = progress * .22;
          posts.forEach(post => { post.scale.y = separation; });
          group.rotation.y = -.22 + progress * .45;
          renderer.render(scene, camera);
        };
        const schedule = () => { if (!frame && visible && !document.hidden) frame = requestAnimationFrame(draw); };
        const resize = () => {
          const { width, height } = host.getBoundingClientRect();
          if (!width || !height) return;
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.position.set(6.5, 5.7, 8.6).multiplyScalar(width < 400 ? 1.18 : 1);
          camera.updateProjectionMatrix();
          schedule();
        };
        const sizeObserver = new ResizeObserver(resize);
        sizeObserver.observe(host);
        const viewObserver = new IntersectionObserver(entries => { visible = Boolean(entries[0]?.isIntersecting); if (visible) schedule(); });
        viewObserver.observe(host);
        const lost = event => { event.preventDefault(); visible = false; setReady(false); };
        renderer.domElement.addEventListener('webglcontextlost', lost);
        window.addEventListener('scroll', schedule, { passive: true });
        document.addEventListener('visibilitychange', schedule);
        release = () => {
          cancelAnimationFrame(frame);
          sizeObserver.disconnect();
          viewObserver.disconnect();
          window.removeEventListener('scroll', schedule);
          document.removeEventListener('visibilitychange', schedule);
          renderer.domElement.removeEventListener('webglcontextlost', lost);
          resources.forEach(resource => resource.dispose());
          renderer.dispose();
          renderer.forceContextLoss();
          renderer.domElement.remove();
          loading = false;
        };
        resize();
        setReady(true);
      } catch {
        release();
        setReady(false);
      }
    };
    const observer = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting) mount(); }, { rootMargin: '200px' });
    observer.observe(host);
    const preferenceChanged = () => { release(); setReady(false); if (!motion.matches) mount(); };
    motion.addEventListener('change', preferenceChanged);
    return () => { disposed = true; observer.disconnect(); motion.removeEventListener('change', preferenceChanged); release(); };
  }, []);

  return <div className={`scope-visual${ready ? ' scope-visual-ready' : ''}`} role="img" aria-label="Three separate scope layers: Aster Medical Supplies company, Mumbai GST registration, and permitted Main and Warehouse branches. User grants are applied to each layer.">
    <div className="scope-visual-header" aria-hidden="true"><span>THE ANATOMY OF A WORKSPACE</span><span>01 — 03</span></div>
    <div className="scope-canvas" ref={holder} />
    <div className="scope-fallback" aria-hidden="true"><div>Company identity</div><div>GST registration</div><div>Permitted branches</div></div>
    <div className="scope-legend" aria-hidden="true"><div><i>01</i><strong>Company</strong><span>Aster Medical Supplies</span></div><div><i>02</i><strong>GST registration</strong><span>Mumbai</span></div><div><i>03</i><strong>Branch grants</strong><span>Main · Warehouse</span></div></div>
  </div>;
}
