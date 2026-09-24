import { Surface } from '@webprodigies/flute';
import PrismDashboard from '../../components/PrismDashboard.jsx';
import { sceneContext } from '../dashboard-fixture.js';

const captureOnly = () => {};

// One intact real React subtree: the camera reveals the related capture-only
// dashboard areas for invoices, stock and local GST review as it travels backward.
export default function WorkspaceTrail() {
  return <Surface id="workspace" style={{ width: 1400, minHeight: 1030, padding: 30, background: '#f5f9ff', border: '1px solid #dce8f6', borderRadius: 22, fontFamily: 'Manrope, sans-serif', color: '#18244d' }}>
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
      <div><strong style={{ fontSize: 27, letterSpacing: '-1px' }}>TesselArk</strong><p style={{ margin: '5px 0 0', fontSize: 12, color: '#626f91' }}>Workspace overview · synthetic scene data</p><a href="/demo" style={{ display: 'inline-block', marginTop: 8, color: '#2469c7', fontSize: 12 }}>Open interactive demo →</a></div>
      <div style={{ textAlign: 'right', fontSize: 12, lineHeight: 1.9 }}>Company: Aster Medical Supplies · Demo<br />Registration: Maharashtra · Branch: Mumbai</div>
    </header>
    <div inert><PrismDashboard context={sceneContext} refreshKey={0} onNavigate={captureOnly} /></div>
  </Surface>;
}
