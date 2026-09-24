import {Audio} from '@remotion/media';
import {AbsoluteFill, Composition, Easing, Img, Interactive, Sequence, interpolate, staticFile, useCurrentFrame} from 'remotion';

const fps = 30;
const sceneFrames = [210, 240, 240, 240, 240, 240, 240, 240, 180];
const starts = sceneFrames.map((_, index) => sceneFrames.slice(0, index).reduce((sum, value) => sum + value, 0));
const totalFrames = sceneFrames.reduce((sum, value) => sum + value, 0);

type Feature = {eyebrow: string; title: string; description: string; cue: string; screens: string[]; tint: string};

const features: Feature[] = [
  {eyebrow: '01 / BUSINESS OVERVIEW', title: 'One clear business picture.', description: 'Sales, purchases and local review stay in the selected company, GSTIN and branch.', cue: 'SCOPE FIRST', screens: ['overview'], tint: '#f4f8ff'},
  {eyebrow: '02 / ORDERS & STOCK', title: 'From intent to movement.', description: 'Follow partial fulfilment into linked invoices, lot control and expiry watch.', cue: 'ORDER → FULFIL → INVOICE', screens: ['orders-detail', 'batches'], tint: '#f4f9fa'},
  {eyebrow: '03 / INVOICE CORRECTNESS', title: 'Review before approval.', description: 'Compare entered tax with dated item policies and keep an accountant decision trail.', cue: 'POLICY + EVIDENCE', screens: ['invoice-checks', 'tax-policies'], tint: '#f6f8ff'},
  {eyebrow: '04 / EVIDENCE', title: 'A source behind every decision.', description: 'Files stay connected to records with version history and internal review.', cue: 'SOURCE LINKED', screens: ['evidence'], tint: '#f3f9f7'},
  {eyebrow: '05 / PERIOD WORK', title: 'The next step has an owner.', description: 'Assigned checklists and independent evidence review make local closure traceable.', cue: 'ASSIGN → REVIEW → CLOSE', screens: ['work-tasks', 'work-tasks-detail'], tint: '#f6f7ff'},
  {eyebrow: '06 / GST WORKSPACE', title: 'Keep the tax story straight.', description: 'Match purchase evidence, review eligible ITC and see the local period position.', cue: 'LOCAL REVIEW', screens: ['gst', 'gst-reviewed'], tint: '#f3f8ff'},
  {eyebrow: '07 / STATUTORY SANDBOX', title: 'Practice every state safely.', description: 'Run synthetic document lifecycles and inspect the local request history.', cue: 'SYNTHETIC REFERENCES ONLY', screens: ['simulator'], tint: '#f6f7ff'},
];

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const opacity = (frame: number, duration: number) => interpolate(frame, [0, 18, duration - 18, duration], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

const TesselSymbol: React.FC<{dark?: boolean}> = ({dark = false}) => (
  <svg width="74" height="74" viewBox="0 0 74 74" fill="none" aria-hidden="true">
    <path d="M6 51 39 9l12 15L17 65z" fill={dark ? '#7AC0FF' : '#5BABF4'} />
    <path d="m22 63 32-37 12 15-32 27z" fill={dark ? '#4B9DFF' : '#2878ED'} />
    <path d="m40 67 27-23 4 20z" fill={dark ? '#A6D6FF' : '#2455B8'} />
  </svg>
);

const FoldedForms: React.FC<{dark?: boolean}> = ({dark = false}) => {
  const frame = useCurrentFrame();
  return (
    <svg viewBox="0 0 780 780" width="780" height="780" style={{overflow: 'visible', translate: `${interpolate(frame, [0, 210], ['0px 0px', '-28px 16px'], {extrapolateRight: 'clamp'})}`, rotate: `${interpolate(frame, [0, 210], [-4, 2], {extrapolateRight: 'clamp'})}deg`}}>
      <circle cx="400" cy="395" r="335" fill={dark ? '#19477C' : '#E0EEFF'} opacity="0.82" />
      <circle cx="400" cy="395" r="270" fill={dark ? '#1A4B88' : '#E9F3FF'} />
      <path d="M146 540 420 110 532 260 258 646Z" fill="#5CA5F2" />
      <path d="M146 540 420 110 532 260Z" fill="#9DCDFB" />
      <path d="M282 650 536 268 664 418 405 680Z" fill="#2C65CE" />
      <path d="M282 650 536 268 664 418Z" fill="#5D94ED" />
      <path d="M430 684 672 432 706 656Z" fill="#A2D0FC" />
      <path d="M146 540 420 110 532 260" fill="none" stroke="white" strokeOpacity="0.46" strokeWidth="5" />
      <path d="M282 650 536 268 664 418" fill="none" stroke="white" strokeOpacity="0.25" strokeWidth="5" />
    </svg>
  );
};

const BrandScene: React.FC<{outro?: boolean; duration: number}> = ({outro = false, duration}) => {
  const frame = useCurrentFrame();
  const dark = outro;
  const entry = interpolate(frame, [0, 30], [58, 0], {extrapolateRight: 'clamp', easing: ease});
  return (
    <AbsoluteFill style={{background: dark ? '#0D2858' : '#F6FAFF', color: dark ? '#FFFFFF' : '#122A55', opacity: outro ? interpolate(frame, [0, 18], [0, 1], {extrapolateRight: 'clamp'}) : opacity(frame, duration)}}>
      <div className="grain" />
      <div className="brand-art" style={{opacity: interpolate(frame, [0, 36], [0, 1], {extrapolateRight: 'clamp'})}}><FoldedForms dark={dark} /></div>
      <Interactive.Div name={outro ? 'Closing message' : 'Opening message'} className="brand-content" style={{translate: `0px ${entry}px`}}>
        <div className="brand-lockup"><TesselSymbol dark={dark} /><span>TesselArk</span></div>
        <div className="brand-line" />
        <h1>{outro ? 'See the work behind every number.' : 'Business work, connected.'}</h1>
        <p>{outro ? 'TesselArk brings the record, the decision and the next step into view.' : 'A clearer view across records, review and local GST preparation.'}</p>
        <div className="brand-trail">{outro ? 'TESSELARK · PRODUCT DEMO' : 'AN INTEGRATED WORKSPACE'}</div>
      </Interactive.Div>
      <span className="legal-footnote">Synthetic demonstration data · Local review and simulator only</span>
    </AbsoluteFill>
  );
};

const FeatureScene: React.FC<{feature: Feature; number: number; duration: number}> = ({feature, number, duration}) => {
  const frame = useCurrentFrame();
  const entry = interpolate(frame, [0, 28], [68, 0], {extrapolateRight: 'clamp', easing: ease});
  const screenEntry = interpolate(frame, [0, 30], [130, 0], {extrapolateRight: 'clamp', easing: ease});
  const change = Math.round(duration * 0.53);
  return (
    <AbsoluteFill style={{background: feature.tint, color: '#102A55', opacity: opacity(frame, duration)}}>
      <div className="feature-grid" /><div className="feature-glow" />
      <div className="feature-top"><div className="feature-brand"><TesselSymbol /><strong>TesselArk</strong></div><span>PRODUCT WALKTHROUGH &nbsp; / &nbsp; {String(number).padStart(2, '0')}</span></div>
      <Interactive.Div name={`${feature.eyebrow} narrative`} className="feature-copy" style={{translate: `0px ${entry}px`}}>
        <span className="eyebrow">{feature.eyebrow}</span><h2>{feature.title}</h2><p>{feature.description}</p>
        <div className="cue"><span className="cue-line" /><strong>{feature.cue}</strong></div>
      </Interactive.Div>
      <Interactive.Div name={`${feature.eyebrow} real app screens`} className="screen-frame" style={{translate: `${screenEntry}px 0px`, scale: interpolate(frame, [0, duration], [1.035, 1], {extrapolateRight: 'clamp'})}}>
        <div className="screen-chrome"><span /><span /><span /><strong>TESSELARK / DEMO WORKSPACE</strong></div>
        <div className="screen-images">
          {feature.screens.map((screen, index) => <Img key={screen} src={staticFile(`screens/${screen}-focus.png`)} style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: feature.screens.length === 1 ? 1 : index === 0 ? interpolate(frame, [change - 15, change + 15], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : interpolate(frame, [change - 15, change + 15], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}} />)}
        </div>
      </Interactive.Div>
      <div className="feature-footer"><span>ASTER MEDICAL SUPPLIES · SYNTHETIC DATA</span><div className="progress"><span style={{width: `${(number / features.length) * 100}%`}} /></div><span>{number} / {features.length}</span></div>
    </AbsoluteFill>
  );
};

const Narration: React.FC = () => {
  const clips = ['intro', 'overview', 'orders', 'invoice', 'evidence', 'tasks', 'gst', 'sandbox', 'outro'];
  return <>
    <Audio src={staticFile('audio/original-score.mp3')} volume={0.48} />
    {clips.map((clip, index) => <Sequence key={clip} from={starts[index] + (index === 0 ? 12 : 18)} durationInFrames={sceneFrames[index] - 18} layout="none"><Audio src={staticFile(`audio/${clip}.mp3`)} volume={1} /></Sequence>)}
  </>;
};

const ProductDemo: React.FC = () => <AbsoluteFill style={{background: '#f6faff'}}>
  <Sequence from={starts[0]} durationInFrames={sceneFrames[0]} name="Opening"><BrandScene duration={sceneFrames[0]} /></Sequence>
  {features.map((feature, index) => <Sequence key={feature.eyebrow} from={starts[index + 1]} durationInFrames={sceneFrames[index + 1]} name={feature.eyebrow}><FeatureScene feature={feature} number={index + 1} duration={sceneFrames[index + 1]} /></Sequence>)}
  <Sequence from={starts[8]} durationInFrames={sceneFrames[8]} name="Closing"><BrandScene outro duration={sceneFrames[8]} /></Sequence>
  <Narration />
</AbsoluteFill>;

export const MyComposition = () => <Composition id="TesselArkProductDemo" component={ProductDemo} durationInFrames={totalFrames} fps={fps} width={1920} height={1080} />;
