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
    let pendingTimer;
    let pendingIdle;
    const mount = async () => {
      if (disposed || loading || motion.matches || navigator.connection?.saveData) return;
      loading = true;
      // Probe before importing the renderer. No-WebGL browsers retain the HTML diagram.
      try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2');
        if (!gl) { loading = false; return; }
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        const T = await import('./three-pieces.js');
        if (disposed || motion.matches) { loading = false; return; }
        const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.outputColorSpace = T.SRGBColorSpace;
        renderer.setClearColor(0xedf4fc, 0);
        const scene = new T.Scene();
        const camera = new T.PerspectiveCamera(36, 1, .1, 100);
        camera.position.set(4.8, 4.2, 6.7);
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
        box(4.65, .12, 3.35, 0x3670bc, 0, -.1, 0, layers[0]);
        box(4.65, .13, 3.35, 0x84ace1, 0, 0, 0, layers[0]);
        box(3.9, .13, 2.75, 0x6f9ed8, 0, -.09, 0, layers[1]);
        box(3.9, .12, 2.75, 0xc3dbfa, 0, 0, 0, layers[1]);
        box(1.7, .13, 2.2, 0x7ca8dc, -.97, -.09, 0, layers[2]);
        box(1.7, .13, 2.2, 0xfafcff, -.97, 0, 0, layers[2]);
        box(1.7, .13, 2.2, 0x7ca8dc, .97, -.09, 0, layers[2]);
        box(1.7, .13, 2.2, 0xfafcff, .97, 0, 0, layers[2]);
        for (const x of [-.94, .94]) {
          box(.34, .06, .34, 0x3e77c9, x - .4, .12, -.6, layers[2]);
          for (let row = 0; row < 3; row++) {
            box(1.05, .035, .07, 0xbdcfea, x, .1, -.03 + row * .25, layers[2]);
          }
        }
        // Registration has its own four record tiles, distinct from branch grants.
        for (const x of [-1.3, -.45, .45, 1.3]) box(.55, .05, .7, 0x8cb3e7, x, .11, .63, layers[1]);
        const posts = [-1.7, 1.7].map(x => box(.022, 2, .022, 0x9dbce4, x, 0, -.75));
        host.appendChild(renderer.domElement);
        renderer.domElement.setAttribute('aria-hidden', 'true');
        let frame = 0;
        let visible = true;
        const draw = () => {
          frame = 0;
          if (!visible || document.hidden || disposed) return;
          const progress = Math.max(0, Math.min(1, window.scrollY / Math.max(1, window.innerHeight * .92)));
          const separation = .5 + progress * .93;
          layers[0].position.y = -separation;
          layers[1].position.y = 0;
          layers[2].position.y = separation;
          layers[2].position.x = progress * .27;
          posts.forEach(post => { post.scale.y = separation; });
          group.rotation.y = -.22 + progress * .37;
          group.rotation.z = progress * -.035;
          camera.position.set(4.8 - progress * .8, 4.2 - progress * .55, 6.7 - progress * .45);
          camera.lookAt(0, 0, 0);
          renderer.render(scene, camera);
        };
        const schedule = () => { if (!frame && visible && !document.hidden) frame = requestAnimationFrame(draw); };
        const resize = () => {
          const { width, height } = host.getBoundingClientRect();
          if (!width || !height) return;
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          schedule();
        };
        const sizeObserver = new ResizeObserver(resize);
        sizeObserver.observe(host);
        const viewObserver = new IntersectionObserver(entries => { visible = Boolean(entries[0]?.isIntersecting); if (visible) schedule(); });
        viewObserver.observe(host);
        const lost = event => { event.preventDefault(); visible = false; release(); setReady(false); };
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
    const observer = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      pendingTimer = window.setTimeout(() => {
        if ('requestIdleCallback' in window) pendingIdle = window.requestIdleCallback(mount, { timeout: 1200 });
        else mount();
      }, 450);
    }, { rootMargin: '80px' });
    observer.observe(host);
    const preferenceChanged = () => { release(); setReady(false); if (!motion.matches) mount(); };
    motion.addEventListener('change', preferenceChanged);
    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(pendingTimer);
      if (pendingIdle) window.cancelIdleCallback(pendingIdle);
      motion.removeEventListener('change', preferenceChanged);
      release();
    };
  }, []);

  return <div className={`scope-visual${ready ? ' scope-visual-ready' : ''}`} role="img" aria-label="Three separate scope layers: Aster Medical Supplies company, Mumbai GST registration, and permitted Main and Warehouse branches. User grants are applied to each layer.">
    <div className="scope-visual-header" aria-hidden="true"><span>BUSINESS CONTEXT / THREE DISTINCT LAYERS</span><span>01 — 03</span></div>
    <span className="scope-side-label scope-side-label-top" aria-hidden="true">BRANCH ACCESS</span>
    <span className="scope-side-label scope-side-label-bottom" aria-hidden="true">COMPANY FOUNDATION</span>
    <div className="scope-canvas" ref={holder} />
    <div className="scope-fallback" aria-hidden="true"><div>Company identity</div><div>GST registration</div><div>Permitted branches</div></div>
    <div className="scope-legend" aria-hidden="true"><div><i>01</i><strong>Company</strong><span>Aster Medical Supplies</span></div><div><i>02</i><strong>GST registration</strong><span>Mumbai</span></div><div><i>03</i><strong>Branch grants</strong><span>Main · Warehouse</span></div></div>
  </div>;
}
