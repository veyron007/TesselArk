import { Surface } from '@webprodigies/flute';
import PrismDashboard from '../../components/PrismDashboard.jsx';
import { sceneContext } from '../dashboard-fixture.js';

const captureOnly = () => {};

// The dashboard remains a real, intact React subtree. Its context plane sits
// behind it so a lateral camera move produces depth without faking app data.
export default function WorkspaceTrail() {
  return <>
    <Surface id="context" style={{ width: 1460, height: 1120, padding: '30px 38px', boxSizing: 'border-box', background: 'linear-gradient(145deg, #f7fbff 0%, #ecf5ff 100%)', border: '1px solid #cbdff4', borderRadius: 30, boxShadow: '0 70px 120px #061b3d26', fontFamily: 'Manrope, sans-serif', color: '#18244d' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div><strong style={{ fontSize: 29, letterSpacing: '-1.3px' }}>TesselArk</strong><span style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#626f91' }}>Workspace overview · synthetic scene data</span></div>
        <div style={{ textAlign: 'right', fontSize: 12, lineHeight: 1.8, color: '#526586' }}>Aster Medical Supplies · Demo<br />Maharashtra GSTIN · Mumbai branch</div>
      </header>
    </Surface>
    <Surface id="workspace" style={{ width: 1370, minHeight: 1000, marginTop: -1050, padding: 24, boxSizing: 'border-box', background: '#fff', border: '1px solid #dce8f6', borderRadius: 24, boxShadow: '0 42px 100px #112e5740', fontFamily: 'Manrope, sans-serif', color: '#18244d' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 24, marginBottom: 18, padding: '0 2px', fontSize: 12, color: '#626f91' }}>
        <span>Real workspace UI · synthetic example records</span>
        <a href="/demo" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 32, padding: '0 13px', borderRadius: 999, border: '1px solid #bbd8fb', background: '#eef6ff', color: '#1757ac', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>Open interactive demo →</a>
      </div>
      <div inert><PrismDashboard context={sceneContext} refreshKey={0} onNavigate={captureOnly} /></div>
    </Surface>
  </>;
}
