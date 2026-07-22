import React from 'react';
import { useRuView } from '../hooks/useRuView';
import { User, Activity, Radio, Wifi, HeartPulse } from 'lucide-react';
import Room3D from '../components/Room3D';

export default function Dashboard() {
  const { data, nodes } = useRuView();
  
  const activeNodesCount = nodes.filter(n => n.status === 'active').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '1.875rem', fontWeight: 'bold' }}>Live Dashboard</h1>
        <div className={`card ${data.isOccupied ? 'glow-text status-occupied' : 'status-empty'}`} style={{ padding: '0.75rem 1.5rem', flexDirection: 'row', alignItems: 'center', gap: '1rem', borderRadius: '2rem' }}>
          <User size={24} className={data.isOccupied ? 'animate-pulse' : ''} />
          <span style={{ fontSize: '1.25rem', fontWeight: 'bold', textTransform: 'uppercase' }}>
            {data.isOccupied ? 'Occupied' : 'Empty'}
          </span>
        </div>
      </div>
      
      <div className="dashboard-grid">
        {/* Node Status */}
        <div className="card" style={{ gridColumn: 'span 4' }}>
          <div className="card-title"><Radio size={16}/> Nodes Status</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '1rem' }}>
             <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: 'var(--accent-blue)'}}>{activeNodesCount}</div>
             <div style={{ color: 'var(--text-secondary)'}}>Online Nodes</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
             {nodes.map((node, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem', background: 'rgba(255,255,255,0.05)', borderRadius: '0.5rem' }}>
                   <span style={{ fontSize: '0.875rem' }}>{node.id || `Node ${i+1}`}</span>
                   <Wifi size={16} color={node.status === 'active' ? 'var(--success)' : 'var(--danger)'} />
                </div>
             ))}
             {nodes.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>No nodes connected.</div>}
          </div>
        </div>

        {/* Motion Level */}
        <div className="card" style={{ gridColumn: 'span 4' }}>
          <div className="card-title"><Activity size={16}/> Motion Intensity</div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
             <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--accent-cyan)', textAlign: 'center', textTransform: 'capitalize' }}>
                {typeof data.motionLevel === 'number' ? data.motionLevel.toFixed(1) : String(data.motionLevel).replace('_', ' ')}
             </div>
             <div style={{ width: '100%', height: '8px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', marginTop: '1rem', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${typeof data.motionLevel === 'number' ? Math.min(data.motionLevel * 10, 100) : (data.motionLevel === 'present_moving' ? 100 : 0)}%`, background: 'var(--accent-cyan)', transition: 'width 0.3s ease' }}></div>
             </div>
          </div>
        </div>

        {/* Vital Signs */}
        <div className="card" style={{ gridColumn: 'span 4' }}>
          <div className="card-title"><HeartPulse size={16}/> Vital Signs</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '1rem' }}>
             <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                   <span style={{ color: 'var(--text-secondary)'}}>Heart Rate</span>
                   <span style={{ fontWeight: 'bold'}}>{data.heartRate} bpm</span>
                </div>
                <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px' }}>
                   <div style={{ height: '100%', width: `${Math.min((data.heartRate / 120) * 100, 100)}%`, background: 'var(--accent-purple)', transition: 'width 0.3s ease' }}></div>
                </div>
             </div>
             <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                   <span style={{ color: 'var(--text-secondary)'}}>Breathing</span>
                   <span style={{ fontWeight: 'bold'}}>{data.breathingRate} rpm</span>
                </div>
                <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px' }}>
                   <div style={{ height: '100%', width: `${Math.min((data.breathingRate / 30) * 100, 100)}%`, background: 'var(--accent-blue)', transition: 'width 0.3s ease' }}></div>
                </div>
             </div>
          </div>
        </div>

        {/* 3D Visualization */}
        <div className="card" style={{ gridColumn: 'span 12', minHeight: '400px', padding: 0, overflow: 'hidden', position: 'relative' }}>
          <div style={{ position: 'absolute', top: '1.5rem', left: '1.5rem', zIndex: 10 }}>
            <div className="card-title glow-text" style={{ margin: 0 }}>Room Spatial View</div>
          </div>
          <Room3D data={data} nodes={nodes} />
        </div>
      </div>
    </div>
  );
}
