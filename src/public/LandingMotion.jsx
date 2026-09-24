import { useEffect } from 'react';

export default function LandingMotion() {
  useEffect(() => {
    let disposed = false;
    let media;
    Promise.all([import('gsap'), import('gsap/ScrollTrigger')]).then(([gsapModule, triggerModule]) => {
      if (disposed) return;
      const gsap = gsapModule.gsap;
      gsap.registerPlugin(triggerModule.ScrollTrigger);
      media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        const context = gsap.context(() => {
          const intro = gsap.timeline({ defaults: { ease: 'power3.out' } });
          intro.from('.hero-copy .public-kicker', { autoAlpha: 0, y: 15, duration: .55, clearProps: 'all' })
            .from('.hero-copy h1', { autoAlpha: 0, y: 28, duration: .85, clearProps: 'all' }, '-=.33')
            .from('.hero-copy > :is(.hero-description, .hero-actions, .hero-note)', {
              autoAlpha: 0, y: 20, duration: .65, stagger: .09, clearProps: 'all',
            }, '-=.55');
          gsap.to('.product-scene', {
            y: -38, ease: 'none', scrollTrigger: { trigger: '.public-hero', start: 'top top', end: 'bottom top', scrub: .8 },
          });
          gsap.to('.hero-scope-visual', {
            y: -24, x: 16, ease: 'none', scrollTrigger: { trigger: '.public-hero', start: 'top top', end: 'bottom top', scrub: .8 },
          });
          gsap.utils.toArray('.section-intro, .trust-copy, .scope-copy, .final-inner > div').forEach(element => {
            gsap.from(element, {
              autoAlpha: 0, y: 30, duration: .85, ease: 'power2.out', clearProps: 'all',
              scrollTrigger: { trigger: element, start: 'top 88%', once: true },
            });
          });
          gsap.from('.platform-composition > *', {
            autoAlpha: 0, y: 36, duration: .9, ease: 'power2.out', stagger: .12, clearProps: 'all',
            scrollTrigger: { trigger: '.platform-composition', start: 'top 86%', once: true },
          });
          gsap.from('.workflow-row', {
            autoAlpha: 0, x: -24, duration: .65, ease: 'power2.out', stagger: .1, clearProps: 'all',
            scrollTrigger: { trigger: '.workflow-list', start: 'top 83%', once: true },
          });
          gsap.to('.scope-visual', {
            y: -32, ease: 'none', scrollTrigger: { trigger: '.scope-section', start: 'top bottom', end: 'bottom top', scrub: 1 },
          });
        });
        return () => context.revert();
      });
    }).catch(() => { /* The page remains fully readable without motion. */ });
    return () => { disposed = true; media?.revert(); };
  }, []);
  return null;
}
