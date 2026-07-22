import React, { useState, useEffect, useRef } from 'react';
import { LogOut, User, Footprints, Zap, CheckCircle, Timer, PlayCircle, AlertCircle } from 'lucide-react';

const STEPS = [
  {
    id: 'empty',
    label: 'Empty Room',
    icon: LogOut,
    color: '#00f2fe',
    duration: 60,
    instruction: 'Leave the room completely. Stay out for the full 60 seconds.',
    tip: 'Close the door if possible. Even pets should be out.',
    recordingId: 'empty',
  },
  {
    id: 'still',
    label: 'Sitting Still',
    icon: User,
    color: '#9b51e0',
    duration: 60,
    instruction: 'Sit completely still within 1 meter of any board for 60 seconds.',
    tip: 'The closer and stiller you are, the better breathing/heart rate accuracy gets.',
    recordingId: 'still',
  },
  {
    id: 'walking',
    label: 'Walking Around',
    icon: Footprints,
    color: '#e0a020',
    duration: 60,
    instruction: 'Walk naturally around the room for 60 seconds.',
    tip: 'Cover the whole room — walk past all three boards.',
    recordingId: 'walking',
  },
];

function CountdownRing({ seconds, total, color }) {
  const r = 36;
  const circ = 2 * Math.PI * r;
  const progress = seconds / total;
  const dash = circ * (1 - progress);

  return (
    <svg width={90} height={90} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={45} cy={45} r={r} fill="none" stroke="#1a2030" strokeWidth={6} />
      <circle
        cx={45} cy={45} r={r} fill="none"
        stroke={color} strokeWidth={6}
        strokeDasharray={circ}
        strokeDashoffset={dash}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 1s linear' }}
      />
      <text x={45} y={45} textAnchor="middle" dominantBaseline="central"
        fill="#fff" fontSize={18} fontWeight="bold"
        style={{ transform: 'rotate(90deg)', transformOrigin: '45px 45px' }}>
        {seconds}
      </text>
    </svg>
  );
}

export default function Training() {
  const [completedSteps, setCompletedSteps] = useState({});
  const [activeStep, setActiveStep] = useState(null);   // step id currently recording
  const [countdown, setCountdown] = useState(0);
  const [trainStatus, setTrainStatus] = useState(null); // null | 'running' | 'done' | 'error'
  const [trainMsg, setTrainMsg] = useState('');
  const [stepError, setStepError] = useState(null);
  const timerRef = useRef(null);

  const allDone = STEPS.every(s => completedSteps[s.id]);

  async function startStep(step) {
    setStepError(null);
    setActiveStep(step.id);
    setCountdown(step.duration);

    try {
      const res = await fetch('/api/v1/recording/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: step.recordingId }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
    } catch (e) {
      setStepError(`Could not start recording: ${e.message}`);
      setActiveStep(null);
      return;
    }

    let remaining = step.duration;
    timerRef.current = setInterval(async () => {
      remaining -= 1;
      setCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timerRef.current);
        try {
          await fetch('/api/v1/recording/stop', { method: 'POST' });
        } catch (_) {}
        setActiveStep(null);
        setCompletedSteps(prev => ({ ...prev, [step.id]: true }));
      }
    }, 1000);
  }

  function cancelStep() {
    clearInterval(timerRef.current);
    fetch('/api/v1/recording/stop', { method: 'POST' }).catch(() => {});
    setActiveStep(null);
  }

  async function runTraining() {
    setTrainStatus('running');
    setTrainMsg('Training model… this takes 30–60 seconds');
    try {
      const res = await fetch('/api/v1/adaptive/train', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setTrainStatus('done');
        setTrainMsg(data.message || 'Training complete! Accuracy should be improved.');
      } else {
        setTrainStatus('error');
        setTrainMsg(data.detail || data.error || 'Training failed.');
      }
    } catch (e) {
      setTrainStatus('error');
      setTrainMsg(`Could not reach RuView server: ${e.message}`);
    }
  }

  useEffect(() => () => clearInterval(timerRef.current), []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div>
        <h1 style={{ fontSize: '1.875rem', fontWeight: 'bold' }}>Adaptive Training</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem', maxWidth: 520 }}>
          Record three 60-second scenarios so the model learns your room's RF environment.
          This is the single biggest step for improving presence, breathing, and heart rate accuracy.
        </p>
      </div>

      {/* Accuracy expectations card */}
      <div className="card" style={{ gridColumn: 'span 12', background: 'rgba(0,180,255,0.05)', borderColor: '#00f2fe33' }}>
        <div className="card-title" style={{ color: '#00f2fe' }}>Realistic accuracy after training</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginTop: '0.75rem' }}>
          {[
            ['Presence detection', '~80%'],
            ['Room zone (half)', '~60%'],
            ['Breathing (still)', '~70% / ±3 BPM'],
            ['Heart rate (still)', '~50% rough'],
          ].map(([label, val]) => (
            <div key={label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '0.75rem' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{label}</div>
              <div style={{ fontWeight: 'bold', color: '#e0e0e0', marginTop: 4 }}>{val}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Step cards */}
      {STEPS.map((step, idx) => {
        const isActive = activeStep === step.id;
        const isDone = completedSteps[step.id];
        const isLocked = !isDone && activeStep && !isActive;
        const Icon = step.icon;

        return (
          <div
            key={step.id}
            className="card"
            style={{
              borderColor: isDone ? `${step.color}66` : isActive ? step.color : undefined,
              opacity: isLocked ? 0.5 : 1,
              transition: 'border-color 0.3s, opacity 0.3s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
              {/* Step number / icon */}
              <div style={{
                width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: isDone ? `${step.color}22` : 'rgba(255,255,255,0.05)',
                border: `2px solid ${isDone ? step.color : '#333'}`,
              }}>
                {isDone
                  ? <CheckCircle size={22} color={step.color} />
                  : <Icon size={20} color={isActive ? step.color : '#888'} />
                }
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontWeight: 'bold', fontSize: '1rem' }}>
                    Step {idx + 1}: {step.label}
                  </span>
                  {isDone && <span style={{ color: step.color, fontSize: '0.8rem' }}>✓ Done</span>}
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: '0.3rem 0' }}>
                  {step.instruction}
                </p>
                <p style={{ color: '#666', fontSize: '0.8rem' }}>💡 {step.tip}</p>

                {/* Active countdown */}
                {isActive && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', marginTop: '1rem' }}>
                    <CountdownRing seconds={countdown} total={step.duration} color={step.color} />
                    <div>
                      <div style={{ color: step.color, fontWeight: 'bold' }}>Recording…</div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: 4 }}>
                        {countdown}s remaining
                      </div>
                      <button
                        onClick={cancelStep}
                        style={{ marginTop: 8, padding: '4px 12px', background: 'rgba(255,80,80,0.15)',
                          border: '1px solid #ff5050', borderRadius: 6, color: '#ff8080',
                          cursor: 'pointer', fontSize: '0.8rem' }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Start button */}
                {!isActive && !isLocked && (
                  <button
                    onClick={() => startStep(step)}
                    style={{
                      marginTop: '0.75rem',
                      padding: '8px 20px',
                      background: isDone ? 'rgba(255,255,255,0.05)' : `${step.color}22`,
                      border: `1px solid ${isDone ? '#444' : step.color}`,
                      borderRadius: 8, color: isDone ? '#888' : step.color,
                      cursor: 'pointer', fontWeight: 'bold', fontSize: '0.875rem',
                      display: 'flex', alignItems: 'center', gap: '0.5rem',
                    }}>
                    <PlayCircle size={16} />
                    {isDone ? 'Re-record' : 'Start Recording'}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {stepError && (
        <div style={{ color: '#ff8080', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
          <AlertCircle size={16} /> {stepError}
        </div>
      )}

      {/* Train button */}
      <div className="card" style={{ borderColor: allDone ? '#9b51e066' : undefined }}>
        <div className="card-title"><Zap size={16} /> Train Model</div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: '0.5rem 0 1rem' }}>
          {allDone
            ? 'All recordings done. Run training to apply them to the model.'
            : `Complete all 3 recordings above first (${Object.keys(completedSteps).length}/3 done).`}
        </p>

        <button
          onClick={runTraining}
          disabled={!allDone || trainStatus === 'running'}
          style={{
            padding: '10px 28px',
            background: allDone ? 'rgba(155,81,224,0.2)' : 'rgba(255,255,255,0.05)',
            border: `1px solid ${allDone ? '#9b51e0' : '#333'}`,
            borderRadius: 8, color: allDone ? '#9b51e0' : '#555',
            cursor: allDone ? 'pointer' : 'not-allowed',
            fontWeight: 'bold', fontSize: '0.95rem',
            display: 'flex', alignItems: 'center', gap: '0.5rem',
          }}>
          {trainStatus === 'running'
            ? <><Timer size={16} /> Training…</>
            : <><Zap size={16} /> Train Model</>}
        </button>

        {trainStatus === 'done' && (
          <div style={{ marginTop: '1rem', color: '#00e080', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <CheckCircle size={16} /> {trainMsg}
          </div>
        )}
        {trainStatus === 'error' && (
          <div style={{ marginTop: '1rem', color: '#ff8080', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertCircle size={16} /> {trainMsg}
          </div>
        )}
      </div>
    </div>
  );
}
