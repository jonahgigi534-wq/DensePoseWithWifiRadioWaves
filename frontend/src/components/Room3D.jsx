import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Box, Html } from '@react-three/drei';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Limb: renders a cylinder between two 3D points
// ---------------------------------------------------------------------------
function Limb({ start, end, radius = 0.05, color = '#9b51e0', emissive = 0.5 }) {
  const { position, quaternion, length } = useMemo(() => {
    const s = new THREE.Vector3(...start);
    const e = new THREE.Vector3(...end);
    const dir = new THREE.Vector3().subVectors(e, s);
    const len = dir.length();
    const mid = new THREE.Vector3().addVectors(s, e).multiplyScalar(0.5);
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize());
    return { position: mid.toArray(), quaternion: q, length: len };
  }, [start[0], start[1], start[2], end[0], end[1], end[2]]);

  return (
    <mesh position={position} quaternion={quaternion}>
      <cylinderGeometry args={[radius, radius, length, 8]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={emissive} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// HumanFigure: full stick-figure humanoid with breathing + vitals label
// ---------------------------------------------------------------------------
function HumanFigure({ person }) {
  const groupRef = useRef();
  const torsoRef = useRef();
  const target = person.position || [0, 0, 0];
  const motionScore = person.motion_score || 0;
  const breathingRate = person.breathing_rate || 0;
  const heartRate = person.heart_rate || 0;
  const confidence = person.confidence ?? 0.5;

  // Pick colour by confidence: purple (high) → teal (mid) → grey (low)
  const color = useMemo(() => {
    if (confidence > 0.7) return '#9b51e0';
    if (confidence > 0.4) return '#00c6e0';
    return '#607080';
  }, [confidence]);

  // Lerp position toward target every frame
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = 0.025;
    groupRef.current.position.x += (target[0] - groupRef.current.position.x) * t;
    groupRef.current.position.z += (target[2] - groupRef.current.position.z) * t;

    // Breathing animation on torso X-scale
    if (torsoRef.current && breathingRate > 0) {
      const breathFreq = breathingRate / 60; // breaths per second
      const phase = clock.getElapsedTime() * breathFreq * Math.PI * 2;
      const expand = 1 + Math.sin(phase) * 0.04;
      torsoRef.current.scale.x = expand;
      torsoRef.current.scale.z = expand;
    }
  });

  // Skeleton keypoints in local Y-up space (height ≈ 1.7 units)
  // All positions are [x, y, z] relative to feet (y=0 is floor)
  const p = {
    head:      [0,    1.60, 0],
    neck:      [0,    1.43, 0],
    lShoulder: [-0.22, 1.32, 0],
    rShoulder: [0.22,  1.32, 0],
    lElbow:    [-0.38, 0.98, 0.04],
    rElbow:    [0.38,  0.98, 0.04],
    lWrist:    [-0.38, 0.62, 0.04],
    rWrist:    [0.38,  0.62, 0.04],
    chest:     [0,    1.32, 0],
    belly:     [0,    0.90, 0],
    lHip:      [-0.13, 0.88, 0],
    rHip:      [0.13,  0.88, 0],
    lKnee:     [-0.16, 0.50, 0],
    rKnee:     [0.16,  0.50, 0],
    lAnkle:    [-0.16, 0.08, 0],
    rAnkle:    [0.16,  0.08, 0],
  };

  // If keypoints available from API, override default positions
  const kps = person.keypoints;
  if (kps && kps.length > 0) {
    const kpMap = {};
    kps.forEach(k => { kpMap[k.name] = k; });
    const roomScale = 8;
    const toLocal = (k) => k ? [(k.x * roomScale - 4), 0.9, (k.y * roomScale - 4)] : null;

    const mappings = [
      ['nose',          'head'],
      ['left_shoulder', 'lShoulder'],
      ['right_shoulder','rShoulder'],
      ['left_elbow',    'lElbow'],
      ['right_elbow',   'rElbow'],
      ['left_wrist',    'lWrist'],
      ['right_wrist',   'rWrist'],
      ['left_hip',      'lHip'],
      ['right_hip',     'rHip'],
      ['left_knee',     'lKnee'],
      ['right_knee',    'rKnee'],
      ['left_ankle',    'lAnkle'],
      ['right_ankle',   'rAnkle'],
    ];
    mappings.forEach(([apiName, bodyKey]) => {
      const mapped = toLocal(kpMap[apiName]);
      if (mapped && (kpMap[apiName]?.confidence ?? 1) > 0.3) {
        p[bodyKey] = mapped;
      }
    });
  }

  const emissive = 0.3 + motionScore * 0.4;

  return (
    <group ref={groupRef} position={[target[0], 0, target[2]]}>
      {/* Head */}
      <mesh position={p.head}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={emissive + 0.2} />
      </mesh>

      {/* Neck */}
      <Limb start={p.neck} end={p.head} radius={0.04} color={color} emissive={emissive} />

      {/* Clavicle / shoulder bar */}
      <Limb start={p.lShoulder} end={p.rShoulder} radius={0.045} color={color} emissive={emissive} />

      {/* Torso (wrapped in group for breathing scale) */}
      <group ref={torsoRef}>
        <Limb start={p.belly} end={p.chest} radius={0.09} color={color} emissive={emissive - 0.1} />
      </group>

      {/* Hip bar */}
      <Limb start={p.lHip} end={p.rHip} radius={0.05} color={color} emissive={emissive} />

      {/* Upper arms */}
      <Limb start={p.lShoulder} end={p.lElbow} radius={0.04} color={color} emissive={emissive} />
      <Limb start={p.rShoulder} end={p.rElbow} radius={0.04} color={color} emissive={emissive} />

      {/* Forearms */}
      <Limb start={p.lElbow} end={p.lWrist} radius={0.033} color={color} emissive={emissive} />
      <Limb start={p.rElbow} end={p.rWrist} radius={0.033} color={color} emissive={emissive} />

      {/* Upper legs */}
      <Limb start={p.lHip} end={p.lKnee} radius={0.055} color={color} emissive={emissive} />
      <Limb start={p.rHip} end={p.rKnee} radius={0.055} color={color} emissive={emissive} />

      {/* Lower legs */}
      <Limb start={p.lKnee} end={p.lAnkle} radius={0.045} color={color} emissive={emissive} />
      <Limb start={p.rKnee} end={p.rAnkle} radius={0.045} color={color} emissive={emissive} />

      {/* Floating vitals label above the head */}
      <Html position={[0, 2.05, 0]} center distanceFactor={6} style={{ pointerEvents: 'none' }}>
        <div style={{
          background: 'rgba(5,8,15,0.82)',
          border: `1px solid ${color}55`,
          borderRadius: '8px',
          padding: '4px 8px',
          color: '#e0e0e0',
          fontSize: '11px',
          lineHeight: 1.6,
          whiteSpace: 'nowrap',
          backdropFilter: 'blur(4px)',
        }}>
          {heartRate > 0 && <div>❤ {Math.round(heartRate)} bpm</div>}
          {breathingRate > 0 && <div>~ {Math.round(breathingRate)} rpm</div>}
          <div style={{ color: '#888', fontSize: '10px' }}>
            {Math.round(confidence * 100)}% conf
          </div>
        </div>
      </Html>

      {/* Ground indicator ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.28, 0.35, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.25} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Node indicator
// ---------------------------------------------------------------------------
function NodeIndicator({ position, isActive }) {
  const meshRef = useRef();
  useFrame(({ clock }) => {
    if (isActive && meshRef.current) {
      const s = 1 + Math.sin(clock.getElapsedTime() * 4) * 0.08;
      meshRef.current.scale.setScalar(s);
    }
  });

  return (
    <group position={position}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.18, 16, 16]} />
        <meshStandardMaterial
          color={isActive ? '#00f2fe' : '#334'}
          emissive={isActive ? '#00f2fe' : '#000'}
          emissiveIntensity={isActive ? 2.5 : 0}
        />
      </mesh>
      {isActive && (
        <mesh>
          <sphereGeometry args={[0.38, 16, 16]} />
          <meshBasicMaterial color='#00f2fe' transparent opacity={0.1} wireframe />
        </mesh>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Zone grid: 3×3 areas (Left/Center/Right × Back/Mid/Front)
// ---------------------------------------------------------------------------
const ZONE_SIZE = 10 / 3; // ~3.33 units per zone

const ZONE_LABELS = [
  ['Back-Left','Back-Center','Back-Right'],
  ['Mid-Left','Mid-Center','Mid-Right'],
  ['Front-Left','Front-Center','Front-Right'],
];

function getZoneCenter(x, z) {
  // Map a continuous [x,z] position to the nearest zone centre
  const col = Math.max(0, Math.min(2, Math.floor((x + 5) / ZONE_SIZE)));
  const row = Math.max(0, Math.min(2, Math.floor((z + 5) / ZONE_SIZE)));
  const cx = -5 + ZONE_SIZE * col + ZONE_SIZE / 2;
  const cz = -5 + ZONE_SIZE * row + ZONE_SIZE / 2;
  return [cx, 0.5, cz];
}

function RoomFloor({ activeZone }) {
  return (
    <>
      <Box args={[10, 0.06, 10]} position={[0, -0.03, 0]}>
        <meshStandardMaterial color='#080c14' />
      </Box>
      {/* Zone tiles */}
      {[0,1,2].map(row => [0,1,2].map(col => {
        const cx = -5 + ZONE_SIZE * col + ZONE_SIZE / 2;
        const cz = -5 + ZONE_SIZE * row + ZONE_SIZE / 2;
        const isActive = activeZone && Math.abs(activeZone[0] - cx) < 0.1 && Math.abs(activeZone[2] - cz) < 0.1;
        return (
          <mesh key={`${row}-${col}`} position={[cx, 0.005, cz]} rotation={[-Math.PI/2, 0, 0]}>
            <planeGeometry args={[ZONE_SIZE - 0.08, ZONE_SIZE - 0.08]} />
            <meshBasicMaterial
              color={isActive ? '#9b51e0' : '#00f2fe'}
              transparent
              opacity={isActive ? 0.10 : 0.025}
            />
          </mesh>
        );
      }))}
      <gridHelper args={[10, 3, '#00f2fe55', '#1a2535']} position={[0, 0.01, 0]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Main exported component
// ---------------------------------------------------------------------------
const DEFAULT_NODE_POSITIONS = [
  [-4, 1.2, -4],
  [4,  1.2, -4],
  [0,  1.2, 4],
];

export default function Room3D({ data, nodes }) {
  // Snap each person to their zone centre — honest about position accuracy
  const snappedPeople = (data.people || []).map(p => {
    const raw = p.position || [0, 0.5, 0];
    const zoneCenter = getZoneCenter(raw[0], raw[2]);
    return { ...p, position: zoneCenter, _rawPos: raw };
  });

  const fallbackPerson = data.isOccupied && snappedPeople.length === 0
    ? [{
        id: 'fallback',
        position: getZoneCenter(0, 0),
        motion_score: data.motionLevel || 0,
        breathing_rate: data.breathingRate || 0,
        heart_rate: data.heartRate || 0,
        confidence: 0.4,
        keypoints: [],
      }]
    : [];

  const allPeople = [...snappedPeople, ...fallbackPerson];
  const activeZone = allPeople[0]?.position ?? null;

  return (
    <div style={{ width: '100%', height: '100%', background: '#04070e' }}>
      <Canvas camera={{ position: [0, 9, 9], fov: 42 }} shadows>
        <ambientLight intensity={0.15} />
        <pointLight position={[0, 6, 0]} intensity={1.2} color='#00f2fe' />
        <pointLight position={[0, 3, 0]} intensity={0.4} color='#6020c0' />

        <RoomFloor activeZone={activeZone} />

        {/* Node indicators */}
        {nodes.length > 0
          ? nodes.map((node, i) => (
              <NodeIndicator
                key={node.node_id ?? node.id ?? i}
                position={DEFAULT_NODE_POSITIONS[i % DEFAULT_NODE_POSITIONS.length]}
                isActive={node.status === 'active'}
              />
            ))
          : <NodeIndicator position={[-4, 1.2, -4]} isActive={false} />
        }

        {/* Humanoid figures at zone centres */}
        {allPeople.map((person, i) => (
          <HumanFigure key={person.id ?? i} person={person} />
        ))}

        <OrbitControls
          enablePan={false}
          maxPolarAngle={Math.PI / 2 - 0.05}
          minDistance={5}
          maxDistance={18}
        />
      </Canvas>
    </div>
  );
}
