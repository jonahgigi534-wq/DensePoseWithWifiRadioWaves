import React, { useState, useEffect } from 'react';
import { Clock, ActivitySquare } from 'lucide-react';

export default function Insights() {
  const [stats, setStats] = useState(null);
  
  useEffect(() => {
    fetch('/api/history/stats')
      .then(res => res.json())
      .then(d => setStats(d))
      .catch(e => console.error("Error fetching stats", e));
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', height: '100%' }}>
      <h1 style={{ fontSize: '1.875rem', fontWeight: 'bold' }}>History & Insights</h1>
      
      <div className="dashboard-grid">
        <div className="card" style={{ gridColumn: 'span 4' }}>
           <div className="card-title"><Clock size={16}/> Total Occupied Time</div>
           <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: 'var(--accent-blue)', marginTop: '1rem' }}>
              {stats ? Math.round(stats.total_occupied_time_seconds / 60) : 0} mins
           </div>
           <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.5rem' }}>Today</div>
        </div>

        <div className="card" style={{ gridColumn: 'span 4' }}>
           <div className="card-title"><ActivitySquare size={16}/> Total Events Recorded</div>
           <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: 'var(--accent-cyan)', marginTop: '1rem' }}>
              {stats ? stats.total_events : 0}
           </div>
           <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.5rem' }}>Since midnight</div>
        </div>
        
        <div className="card" style={{ gridColumn: 'span 12', minHeight: '300px' }}>
           <div className="card-title"><ActivitySquare size={16}/> Occupancy Timeline</div>
           <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
              (Future integration: Chart.js / Recharts timeline goes here)
           </div>
        </div>
      </div>
    </div>
  );
}
