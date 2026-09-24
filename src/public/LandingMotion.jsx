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
          gsap.from('.hero-copy > :is(.public-kicker, h1, .hero-description, .hero-actions, .hero-note)', {
            y: 20, opacity: 0, duration: .82, stagger: .085, ease: 'power3.out', clearProps: 'all',
          });
          gsap.from('.hero-visual', { y: 27, opacity: 0, duration: 1, delay: .12, ease: 'power2.out', clearProps: 'all' });
          gsap.to('.hero-scroll-cue i', { scaleX: 1.35, transformOrigin: 'left', ease: 'none', scrollTrigger: { trigger: '.public-hero', start: 'top top', end: 'bottom top', scrub: true } });
          gsap.utils.toArray('.section-intro, .workflow-heading, .review-copy, .trust-copy, .trust-ledger').forEach(element => {
            gsap.from(element, { y: 24, opacity: 0, duration: .8, ease: 'power2.out', clearProps: 'all', scrollTrigger: { trigger: element, start: 'top 90%', once: true } });
          });
          gsap.utils.toArray('.workflow-row, .review-stage').forEach(element => {
            gsap.from(element, { x: 20, opacity: 0, duration: .68, ease: 'power2.out', clearProps: 'all', scrollTrigger: { trigger: element, start: 'top 93%', once: true } });
          });
          gsap.to('.final-symbol', { y: -45, rotation: -8, ease: 'none', scrollTrigger: { trigger: '.final-section', start: 'top bottom', end: 'bottom bottom', scrub: .8 } });
        }, root.current);
        return () => context.revert();
      });
      media.add('(min-width: 1024px) and (prefers-reduced-motion: no-preference)', () => {
        const context = gsap.context(() => {
          // Hold the real, readable workspace in view while depth settles into a flat record.
          gsap.timeline({ scrollTrigger: { trigger: '.hero-stage', start: 'top 38px', end: '+=80%', scrub: .8, pin: true, anticipatePin: 1, refreshPriority: 1 } })
            .fromTo('.scene-platform', { rotationX: 8, rotationY: -4, y: 55, scale: .93 }, { rotationX: 0, rotationY: 0, y: 0, scale: 1, ease: 'none', duration: .58 })
            .to('.stage-heading', { y: -12, opacity: .35, ease: 'none', duration: .25 }, .57)
            .to('.specimen-review', { y: -11, x: -7, ease: 'none', duration: .32 }, .61)
            .to('.stage-endnote span', { color: '#245fb8', stagger: .08, ease: 'none', duration: .2 }, .66);
        }, root.current);
        return () => context.revert();
      });
      media.add('(max-width: 1023px) and (prefers-reduced-motion: no-preference)', () => {
        const context = gsap.context(() => {
          gsap.fromTo('.scene-platform', { rotationX: 6, y: 25, scale: .98 }, { rotationX: 0, y: 0, scale: 1, ease: 'none', scrollTrigger: { trigger: '.hero-stage', start: 'top 90%', end: 'top 35%', scrub: .6 } });
        }, root.current);
        return () => context.revert();
      });
      document.fonts?.ready.then(() => { if (!disposed) ScrollTrigger.refresh(); });
    }).catch(() => { /* The page stays readable when optional motion cannot load. */ });
    return () => { disposed = true; media?.revert(); };
  }, [root]);
  return null;
}
