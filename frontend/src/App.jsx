import React from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { Activity, BarChart3, Radio, Zap } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Insights from './pages/Insights';
import Training from './pages/Training';

function App() {
  return (
    <BrowserRouter>
      <div className="app-container">
        <aside className="sidebar">
          <div className="sidebar-title">
            PresenceApp
          </div>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <NavLink to="/" className={({isActive}) => isActive ? "nav-link active" : "nav-link"}>
              <Activity size={20} />
              Live Dashboard
            </NavLink>
            <NavLink to="/insights" className={({isActive}) => isActive ? "nav-link active" : "nav-link"}>
              <BarChart3 size={20} />
              History & Insights
            </NavLink>
            <NavLink to="/training" className={({isActive}) => isActive ? "nav-link active" : "nav-link"}>
              <Zap size={20} />
              Adaptive Training
            </NavLink>
          </nav>
          
          <div style={{ marginTop: 'auto', padding: '1rem', background: 'rgba(255,255,255,0.05)', borderRadius: '0.5rem' }}>
             <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)'}}>
                <Radio size={16} />
                <span style={{ fontSize: '0.875rem'}}>System Status</span>
             </div>
             <div style={{ marginTop: '0.5rem', color: 'var(--success)', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--success)', boxShadow: '0 0 10px var(--success)'}}></div>
                All Systems Nominal
             </div>
          </div>
        </aside>
        
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/training" element={<Training />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
