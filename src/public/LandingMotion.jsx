import { useEffect } from 'react';

export default function LandingMotion({ root }) {
  useEffect(() => {
    let disposed = false;
    let media;
    Promise.all([import('gsap'), import('gsap/ScrollTrigger')]).then(([{ gsap }, { ScrollTrigger }]) => {
      if (disposed || !root.current) return;
      gsap.registerPlugin(ScrollTrigger);
      media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        const context = gsap.context(() => {
          gsap.from('.hero-copy, .hero-introduction', { y: 22, opacity: 0, duration: .9, stagger: .12, ease: 'power3.out', clearProps: 'all' });
          // The window settles into a flat, readable surface as the visitor approaches it.
          gsap.fromTo('.hero-stage .scene-platform', { rotationX: 7, y: 24, scale: .97 }, {
            rotationX: 0, y: 0, scale: 1, ease: 'none',
            scrollTrigger: { trigger: '.hero-stage', start: 'top 75%', end: 'top 12%', scrub: .6 },
          });
          gsap.utils.toArray('.section-intro, .workflow-heading, .scope-copy, .trust-copy, .trust-ledger').forEach(element => {
            gsap.from(element, { y: 24, opacity: 0, duration: .8, ease: 'power2.out', clearProps: 'all', scrollTrigger: { trigger: element, start: 'top 92%', once: true } });
          });
          gsap.utils.toArray('.workflow-row').forEach(element => {
            gsap.from(element, { x: 24, opacity: 0, duration: .65, clearProps: 'all', scrollTrigger: { trigger: element, start: 'top 92%', once: true } });
          });
          gsap.to('.final-symbol', { y: -40, rotation: -10, ease: 'none', scrollTrigger: { trigger: '.final-section', start: 'top bottom', end: 'bottom bottom', scrub: 1 } });
        }, root.current);
        return () => context.revert();
      });
      document.fonts?.ready.then(() => { if (!disposed) ScrollTrigger.refresh(); });
    }).catch(() => { /* Optional enhancement: content remains visible if motion cannot load. */ });
    return () => { disposed = true; media?.revert(); };
  }, [root]);
  return null;
}
