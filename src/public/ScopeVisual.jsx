import { useEffect, useRef, useState } from 'react';

export default function ScopeVisual({ compact = false }) {
  const holder = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = holder.current;
    if (!host || window.matchMedia('(prefers-reduced-motion: reduce), (max-width: 799px)').matches) return;
    let disposed = false;
    let cleanup = () => {};
    const observer = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      import('./three-pieces.js').then(THREE => {
        if (disposed) return;
        let renderer;
        try {
          renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
          renderer.outputColorSpace = THREE.SRGBColorSpace;
          renderer.setClearColor(0xffffff, 0);
        } catch { return; }

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(33, 1, .1, 100);
        camera.position.set(5.3, 4.1, 7.1);
        camera.lookAt(0, 0, 0);
        scene.add(new THREE.AmbientLight(0xffffff, 2.2));
        const light = new THREE.DirectionalLight(0xffffff, 3.5);
        light.position.set(2, 7, 5);
        scene.add(light);

        const stack = new THREE.Group();
        scene.add(stack);
        const resources = [];
        const plates = [
          { y: -.75, x: -.27, color: 0x70a8ed, edge: 0x1858b0 },
          { y: 0, x: .05, color: 0xb5d7ff, edge: 0x2568c1 },
          { y: .75, x: .35, color: 0xf1f8ff, edge: 0x1858b0 },
        ];
        plates.forEach((plate, index) => {
          const geometry = new THREE.BoxGeometry(3.65, .14, 2.55);
          const material = new THREE.MeshStandardMaterial({ color: plate.color, metalness: .05, roughness: .26, transparent: true, opacity: .89 });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(plate.x, plate.y, index * -.15);
          stack.add(mesh);
          resources.push(geometry, material);
          const edgeGeometry = new THREE.EdgesGeometry(geometry);
          const edgeMaterial = new THREE.LineBasicMaterial({ color: plate.edge, transparent: true, opacity: .72 });
          const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
          edges.position.copy(mesh.position);
          stack.add(edges);
          resources.push(edgeGeometry, edgeMaterial);
        });
        const linkGeometry = new THREE.CylinderGeometry(.025, .025, 1.55, 8);
        const linkMaterial = new THREE.MeshBasicMaterial({ color: 0x3373c8 });
        for (const x of [-1.15, 1.25]) {
          const link = new THREE.Mesh(linkGeometry, linkMaterial);
          link.position.set(x, 0, -.52);
          stack.add(link);
        }
        resources.push(linkGeometry, linkMaterial);
        const dotGeometry = new THREE.SphereGeometry(.09, 12, 10);
        const dotMaterial = new THREE.MeshStandardMaterial({ color: 0x2368ca, roughness: .25 });
        for (const y of [-.75, 0, .75]) {
          const dot = new THREE.Mesh(dotGeometry, dotMaterial);
          dot.position.set(1.25, y, -.52);
          stack.add(dot);
        }
        resources.push(dotGeometry, dotMaterial);

        host.appendChild(renderer.domElement);
        renderer.domElement.setAttribute('aria-hidden', 'true');
        const resize = () => {
          const { width, height } = host.getBoundingClientRect();
          if (!width || !height) return;
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.render(scene, camera);
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);
        resize();
        let visible = true;
        const visibilityObserver = new IntersectionObserver(entries => {
          visible = Boolean(entries[0]?.isIntersecting);
          if (visible) renderer.setAnimationLoop(animate);
          else renderer.setAnimationLoop(null);
        }, { threshold: .01 });
        visibilityObserver.observe(host);
        let lastFrame = 0;
        function animate(time) {
          if (!visible || time - lastFrame < 30) return;
          lastFrame = time;
          stack.rotation.y = Math.sin(time * .00023) * .13;
          stack.rotation.z = Math.sin(time * .00017) * .025;
          renderer.render(scene, camera);
        }
        const lost = event => { event.preventDefault(); setReady(false); renderer.setAnimationLoop(null); };
        renderer.domElement.addEventListener('webglcontextlost', lost);
        setReady(true);
        cleanup = () => {
          renderer.setAnimationLoop(null);
          resizeObserver.disconnect();
          visibilityObserver.disconnect();
          renderer.domElement.removeEventListener('webglcontextlost', lost);
          resources.forEach(resource => resource.dispose());
          renderer.dispose();
          renderer.domElement.remove();
        };
      }).catch(() => {});
    });
    observer.observe(host);
    return () => { disposed = true; observer.disconnect(); cleanup(); };
  }, []);

  return <div className={`scope-visual ${compact ? 'hero-scope-visual' : ''} ${ready ? 'scope-visual-ready' : ''}`} aria-hidden="true"><div className="scope-canvas" ref={holder} /><div className="scope-fallback"><span /><span /><span /></div>{compact ? <span className="hero-scope-caption">COMPANY · GSTIN · BRANCH</span> : <><div className="scope-label scope-label-company">COMPANY <strong>Business boundary</strong></div><div className="scope-label scope-label-gstin">GSTIN <strong>Registration scope</strong></div><div className="scope-label scope-label-branch">BRANCH <strong>Permitted work</strong></div></>}</div>;
}
