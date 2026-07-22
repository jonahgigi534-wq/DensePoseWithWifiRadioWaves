# WiFi CSI Presence Sensing — Research Document

**Project:** PresenceApp / RuView  
**Date:** June 2026  
**Status:** Working prototype — accuracy improvement roadmap included

---

## Table of Contents

1. [What Is This Project — Simple Terms](#1-what-is-this-project--simple-terms)
2. [What Is This Project — Technical Terms](#2-what-is-this-project--technical-terms)
3. [How It Currently Works — Full Pipeline](#3-how-it-currently-works--full-pipeline)
4. [Why the Current System Is Inaccurate](#4-why-the-current-system-is-inaccurate)
5. [Accuracy Improvement Roadmap](#5-accuracy-improvement-roadmap)
6. [Implementation Plan — What to Do and In What Order](#6-implementation-plan--what-to-do-and-in-what-order)

---

## 1. What Is This Project — Simple Terms

When you connect to WiFi, your router and your phone are constantly sending invisible radio waves back and forth. These waves travel through the air and bounce off walls, furniture — and your body.

Your body is mostly water, which absorbs and reflects radio waves in a very specific way. When you move, breathe, or even just have a heartbeat, your body shifts slightly, which changes how those radio waves bounce around the room.

This project **listens to those changes** using small ESP32 microcontroller boards placed around a room. Instead of using cameras or wearables, it detects:

- **Whether someone is in the room** — your body's presence creates a distinct pattern
- **Where you are in the room** — signals from multiple nodes are stronger when you're closer to them
- **How fast you're breathing** — your chest rising and falling creates a slow, rhythmic ripple in the signal (~0.15–0.5 Hz, or 6–30 times per minute)
- **Your heart rate** — your heartbeat creates a much smaller, faster ripple (~1 Hz, or 60–100 times per minute)

Think of it like sonar, or like how a bat navigates — except instead of sound bouncing off objects, it's WiFi signals bouncing off your body. And instead of a bat, it's a cheap $5 chip on a circuit board.

**The promise:** A room that knows you're there, knows if you fell, tracks your breathing while you sleep, and monitors your heart rate — all with no cameras, no wearables, complete privacy.

---

## 2. What Is This Project — Technical Terms

### The Physics

WiFi operates using **OFDM (Orthogonal Frequency Division Multiplexing)** — a technique that splits a single wireless channel into many parallel sub-channels called **subcarriers** (typically 30–56 per 20 MHz channel in 802.11n/ac).

Each subcarrier transmits a complex number `H = A·e^(jφ)` where:
- `A` (amplitude) = how strong the signal is after travelling through the room
- `φ` (phase) = the timing offset of the wave

This per-subcarrier complex response is called **Channel State Information (CSI)**. Unlike RSSI (Received Signal Strength Indicator), which gives you a single number for the whole channel, CSI gives you a full **frequency-domain snapshot** of the radio channel — tens or hundreds of values per packet.

When a human body is in the room, it creates **dynamic multipath**: radio waves that bounce off the body before reaching the receiver arrive at slightly different times and angles than the direct path. Any movement — walking, breathing, heartbeat — changes the body's position by millimeters to centimeters, which shifts these multipath components. This shows up as time-varying changes in the CSI amplitude and phase across subcarriers.

Key signal components:
- **Breathing (0.1–0.5 Hz):** chest wall displacement of ~5–10 mm causes measurable phase variation
- **Heartbeat (0.8–2.0 Hz):** cardiac contraction causes ~1 mm chest wall motion — 10× smaller than breathing, embedded in the same signal

### The Hardware

Each sensing node is an **ESP32-S3 or ESP32-C6** running custom firmware built on ESP-IDF v5.4. The ESP32 uses its WiFi radio in **promiscuous mode** to capture 802.11 management and data frames from an access point, extracting the CSI payload from the HT-LTF (High Throughput Long Training Field) preamble. This gives I/Q data for each subcarrier — typically 64 samples per frame — at a rate of up to 50 frames/second.

The firmware runs a **dual-core DSP pipeline**:
- Core 0 (WiFi ISR): captures and enqueues raw I/Q data into a lock-free ring buffer
- Core 1 (FreeRTOS task): pops frames, runs biquad IIR bandpass filters, extracts BPM via zero-crossing and autocorrelation, computes presence score via Schmitt trigger hysteresis, then transmits vitals packets over UDP

---

## 3. How It Currently Works — Full Pipeline

```
┌─────────────────────────────────┐
│  WiFi AP (Access Point)         │  ← Any 2.4 GHz router in the room
│  Sends 802.11n frames           │
└──────────────┬──────────────────┘
               │  Radio waves through air
               ▼
┌─────────────────────────────────┐
│  ESP32 Node(s) — Firmware       │
│  Promiscuous capture @ 20 Hz    │
│  Extract I/Q CSI per subcarrier │
│  Dual-core DSP:                 │
│   → Biquad bandpass (BR/HR)     │
│   → Zero-crossing BPM estimate  │
│   → Autocorrelation + harmonic  │
│     rejection for HR            │
│   → Presence hysteresis (5 frm) │
│  Send UDP 5005 → backend        │
└──────────────┬──────────────────┘
               │  Binary UDP (0xC5110001 CSI / 0xC5110002 Vitals)
               ▼
┌─────────────────────────────────┐
│  FastAPI Backend (port 4000)    │
│  csi_bridge.py                  │
│   → Parse binary packets        │
│   → RSSI → distance (path-loss) │
│   → Trilaterate position        │
│   → EMA smooth vitals           │
│   → Broadcast sensing_update    │
└──────────────┬──────────────────┘
               │  WebSocket JSON
               ▼
┌─────────────────────────────────┐
│  React Frontend (Vite, port 5173│
│   → Kalman filter on position   │
│   → Three.js 3D room            │
│   → Live vitals display         │
└─────────────────────────────────┘
```

### Key Parameters (Current)

| Parameter | Value | Notes |
|-----------|-------|-------|
| CSI frame rate | ~13–20 Hz | Limited by promiscuous capture traffic |
| Subcarriers | 30–64 per frame | Depends on 802.11n channel config |
| Breathing band | 0.1–0.5 Hz | 6–30 BPM |
| Heart rate band | 0.8–2.0 Hz | 48–120 BPM |
| Position method | RSSI trilateration | Weighted centroid across 3 nodes |
| Nodes | 3 (corners + front-center) | 10×10 m room |
| Update rate to UI | 5 Hz (CSI) / 1 Hz (vitals) | Vitals from firmware DSP |

---

## 4. Why the Current System Is Inaccurate

### 4.1 Phase Noise — The Biggest Hidden Problem

The most critical issue that the current code does not address at all: **CSI phase is not calibrated**.

WiFi hardware introduces two major systematic errors into the phase of every CSI measurement:
- **STO (Symbol Timing Offset):** the receiver doesn't know exactly when the transmitted symbol started, adding a linearly-increasing phase offset across subcarriers: `φ_error[k] = 2π·k·STO/N`
- **CFO (Carrier Frequency Offset):** the transmitter and receiver don't share a clock, adding a time-varying random phase drift across ALL subcarriers simultaneously

These two errors completely overwhelm the tiny phase signal from breathing (~1–5 degrees of phase shift per breath). The current firmware only uses **amplitude** variance (std_dev of mean amplitude per frame), not phase. This means it's throwing away approximately 70% of the available signal.

**What to do:** Conjugate-multiply adjacent subcarriers to cancel STO. Apply linear regression across subcarrier index to remove the slope. This is called **CSI phase sanitization** and doubles the effective SNR instantly — no new hardware required.

### 4.2 BPM Estimation — 1970s Signal Processing

The current BPM estimator uses:
1. **Zero-crossing counting** on the bandpass-filtered signal
2. **Autocorrelation** with breathing harmonic rejection

These methods work when the signal is clean and stationary. In practice, the CSI signal has:
- **Non-stationarity**: the signal changes character as you move
- **Harmonic interference**: breathing at 0.2 Hz has harmonics at 0.4, 0.6, 0.8 Hz, with the 4th harmonic (0.8 Hz = 48 BPM) inside the heart-rate detection band
- **Motion artifacts**: any body movement during data collection contaminates the frequency estimate

Better approaches: **MUSIC algorithm** (super-resolution spectral estimator), **Wavelet decomposition**, or a trained LSTM that has learned what a breathing signal looks like across thousands of examples.

### 4.3 RSSI Trilateration — Fundamentally Limited

The position estimation uses RSSI (signal strength) from each node to estimate distance, then triangulates. This has fundamental limitations:

- **RSSI is a single number** — it collapses the entire rich CSI frequency response into one power measurement
- **Multipath corrupts RSSI** — a reflection off a wall can make a signal appear stronger from the wrong direction
- **Indoor path-loss is not a clean power law** — walls, furniture, and the human body all scatter signal non-linearly
- **Expected error:** ±1–3 meters, even with perfectly calibrated nodes

Current system accuracy: position is snapped to a 3×3 grid (zones ~3.3×3.3 m), so you can only know which of 9 zones the person is in, not their actual location.

CSI-based fingerprinting (see below) can achieve ±0.3–0.5 m in the same room with no additional hardware.

### 4.4 No Phase Calibration Between Nodes

When using multiple nodes, phase differences between them would give precise angle-of-arrival information. But because each ESP32 has its own oscillator, there's no shared phase reference. The nodes are effectively time-asynchronous. This means we can only use amplitude/RSSI across nodes, not coherent phase.

The current firmware has `c6_timesync.c` and `c6_sync_espnow.c` — time synchronization modules — but phase-level synchronization would require sub-nanosecond accuracy, which is beyond standard timesync.

### 4.5 Summary of Accuracy Bottlenecks

| Issue | Impact on Accuracy | Fixable Without New Hardware? |
|-------|-------------------|-------------------------------|
| No phase sanitization | ×2–3 SNR loss | Yes — software only |
| Weak BPM estimator | ±3–5 BPM error | Yes — software/ML |
| RSSI trilateration | ±1–3 m position error | Partially — needs training data |
| No person-specific calibration | 20–30% higher error | Yes — training session |
| Environmental noise (HVAC) | False presence, wrong BPM | Partially — motion gate |
| Single antenna per node | No spatial diversity | Requires hardware |
| Fixed bandpass frequencies | Wrong when sample rate drifts | Yes — software |

---

## 5. Accuracy Improvement Roadmap

These are ordered from highest impact to lowest cost. Do them in order.

---

### Tier 1 — Software Fixes (Free, 1–2 Days Each)

#### 1A. CSI Phase Sanitization

**What:** Apply conjugate multiplication to adjacent subcarriers to cancel STO, then linear detrend across subcarrier index to remove CFO. This makes the phase time series usable for the first time.

**How to implement in `csi_bridge.py`:**

```python
import numpy as np

def sanitize_phase(iq_bytes: bytes, n_sub: int) -> np.ndarray:
    """Extract phase, remove STO linear slope via conjugate multiplication."""
    iq = np.frombuffer(iq_bytes, dtype=np.int8).reshape(n_sub, 2).astype(float)
    csi = iq[:, 0] + 1j * iq[:, 1]               # complex CSI per subcarrier
    # Conjugate multiply adjacent: cancels STO (linear phase slope)
    conj_prod = csi[1:] * np.conj(csi[:-1])
    phase_diff = np.angle(conj_prod)              # unwrapped phase difference
    # Cumulative sum gives calibrated phase
    phase = np.concatenate([[0], np.cumsum(phase_diff)])
    # Remove any remaining linear trend (CFO)
    trend = np.polyfit(np.arange(n_sub), phase, 1)
    return phase - np.polyval(trend, np.arange(n_sub))
```

Use this phase signal (instead of amplitude variance) as input to your breathing and HR estimators. Expected improvement: SNR ×2–3, breathing estimate much smoother, HR detection significantly more reliable.

#### 1B. Subcarrier Selection via PCA

**What:** Not all 30–64 subcarriers are equally useful. Subcarriers near band edges and DC carry mostly noise. Use **Principal Component Analysis** to automatically find which combination of subcarriers captures the most motion information.

**How:**
```python
# Collect 5-second CSI window: shape = (n_frames, n_subcarriers)
# Run PCA
from sklearn.decomposition import PCA
pca = PCA(n_components=5)
csi_window = np.array(phase_buffer)          # (100 frames × 52 subcarriers)
projections = pca.fit_transform(csi_window)  # (100 frames × 5 components)
# Use projections[:, 0] (highest variance) for breathing estimation
# Use projections[:, 1] for HR (different spatial frequency)
```

The first principal component typically captures large-motion events; the second often isolates breathing; a later component sometimes captures heartbeat. No training data required — PCA is computed from the live signal window.

#### 1C. MUSIC Algorithm for BPM Estimation

**What:** Multiple Signal Classification (MUSIC) is a super-resolution spectral estimator that is dramatically more accurate than zero-crossing or FFT for periodic signals in noise. It uses eigendecomposition of the signal's autocorrelation matrix to separate signal subspace from noise subspace.

**Why it's better:** Zero-crossing needs a clean, single-frequency signal. MUSIC works even when SNR is low and multiple frequency components overlap.

**Python implementation for the backend** (run on the 5-second phase buffer):
```python
def music_bpm(signal: np.ndarray, fs: float, bpm_lo: float, bpm_hi: float,
              n_sources: int = 1) -> float:
    """MUSIC pseudospectrum — returns dominant BPM in [bpm_lo, bpm_hi]."""
    N = len(signal)
    M = N // 3       # autocorrelation matrix size
    # Build autocorrelation matrix
    R = np.zeros((M, M), dtype=complex)
    for i in range(M):
        for j in range(M):
            R[i, j] = np.mean(signal[abs(i-j):N-abs(i-j)] *
                               np.conj(signal[abs(i-j):N-abs(i-j)] if i==j
                                       else signal[:N-abs(i-j)]))
    # Eigendecompose
    eigvals, eigvecs = np.linalg.eigh(R)
    noise_vecs = eigvecs[:, :-n_sources]  # noise subspace
    # Scan frequencies
    freqs = np.linspace(bpm_lo / 60, bpm_hi / 60, 500)
    pseudo = np.zeros(len(freqs))
    for k, f in enumerate(freqs):
        sv = np.exp(1j * 2 * np.pi * f * np.arange(M) / fs)
        pseudo[k] = 1 / np.real(sv.conj() @ noise_vecs @ noise_vecs.conj().T @ sv)
    return freqs[np.argmax(pseudo)] * 60  # BPM
```

Run `music_bpm(phase_signal, fs=20, bpm_lo=6, bpm_hi=30)` for breathing, `music_bpm(phase_signal, fs=20, bpm_lo=48, bpm_hi=120)` for HR.

#### 1D. Dynamic Empty-Room Calibration

**What:** The current presence threshold (`std_dev > 8.0`) is hardcoded. Your specific room, WiFi environment, and AP traffic will have a different baseline noise floor. Running a 60-second "empty room" calibration and setting the threshold to `baseline_std + 3σ` would eliminate most false presences from HVAC.

**How:** The `Training.jsx` page already has a calibration UI. Add a backend endpoint that records the empty-room CSI variance for 60 seconds and writes the computed threshold to a config file read by the firmware or bridge.

---

### Tier 2 — Camera-Assisted Training (Highest Impact for Position, ~1–2 Weeks)

This is the single biggest leap in accuracy you can make. A USB webcam is used **temporarily** to collect ground-truth position labels while simultaneously collecting CSI data. The camera is then removed and the trained model runs forever.

#### How It Works

1. Mount a cheap USB webcam in a room corner with full view of the floor space
2. Run **MediaPipe Pose** (free, runs on CPU) to get real-time skeleton keypoints — specifically the hip midpoint, which is a stable proxy for body position (x, z)
3. Time-synchronize camera frames with CSI packets (both timestamped by the backend)
4. Collect 1–2 hours of data across many scenarios: sitting, standing, walking, lying down, at different positions in the room
5. Train a small CNN+LSTM model: input = CSI amplitude matrix (subcarriers × time), output = (x, z) floor position
6. Deploy the model in the backend, remove the camera

#### What to Install

```bash
pip install mediapipe opencv-python torch torchvision
```

You need MediaPipe, OpenCV for camera capture, and PyTorch for training.

#### Data Collection Script (add to backend)

```python
import cv2
import mediapipe as mp
import asyncio, json, time, csv

mp_pose = mp.solutions.pose
pose = mp_pose.Pose(min_detection_confidence=0.7)

async def collect_training_data(csi_buffer, output_file="training_data.csv"):
    cap = cv2.VideoCapture(0)
    with open(output_file, "w") as f:
        writer = csv.writer(f)
        writer.writerow(["timestamp", "x", "z", "csi_features..."])
        while True:
            ret, frame = cap.read()
            if not ret: continue
            results = pose.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            if results.pose_landmarks:
                lhip = results.pose_landmarks.landmark[23]
                rhip = results.pose_landmarks.landmark[24]
                # Map normalized camera coords to room coords (calibrate once)
                x = (lhip.x + rhip.x) / 2 * ROOM_WIDTH - ROOM_WIDTH/2
                z = (lhip.y + rhip.y) / 2 * ROOM_DEPTH - ROOM_DEPTH/2
                # Flatten last 50-frame CSI window as feature vector
                features = np.array(csi_buffer[-50]).flatten().tolist()
                writer.writerow([time.time(), x, z] + features)
            await asyncio.sleep(0.05)   # 20 Hz
```

#### Model Architecture

```python
import torch
import torch.nn as nn

class CSIPositionNet(nn.Module):
    def __init__(self, n_subcarriers=52, seq_len=50):
        super().__init__()
        # CNN to extract spatial features across subcarriers
        self.cnn = nn.Sequential(
            nn.Conv1d(seq_len, 64, kernel_size=5, padding=2),
            nn.ReLU(),
            nn.Conv1d(64, 128, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(16),
        )
        # LSTM to capture temporal dynamics
        self.lstm = nn.LSTM(128, 256, batch_first=True, num_layers=2)
        # Output: (x, z) in meters
        self.head = nn.Sequential(
            nn.Linear(256, 64),
            nn.ReLU(),
            nn.Linear(64, 2),   # x, z
        )

    def forward(self, x):   # x: (batch, seq_len, n_subcarriers)
        b = x.shape[0]
        feat = self.cnn(x)                   # (batch, 128, 16)
        feat = feat.permute(0, 2, 1)         # (batch, 16, 128)
        _, (h, _) = self.lstm(feat)
        return self.head(h[-1])              # (batch, 2)
```

Training on a standard laptop CPU with 1 hour of data (~72,000 samples): approximately 30–60 minutes.  
**Expected position accuracy:** ±0.3–0.5 m — a 4–6× improvement over RSSI trilateration.

#### What the Camera Sees vs. What Gets Deployed

| Phase | Uses Camera? | Accuracy |
|-------|-------------|----------|
| Data collection | Yes | N/A |
| Training | No (post-hoc) | N/A |
| Inference (live use) | **No** | ±0.3–0.5 m |

The camera is a training tool only. After training, it is disconnected and never used again.

---

### Tier 3 — Deep Learning for Vitals (Highest Impact for HR/Breathing, ~2–4 Weeks)

#### What to Buy

To train a model for breathing and heart rate, you need **ground truth measurements** collected simultaneously with CSI. You need to wear a sensor during the data collection phase only.

| Device | Measures | Cost | Notes |
|--------|----------|------|-------|
| **Polar H10** chest strap | HR + breathing (via chest expansion) | ~$80 | Best accuracy, Bluetooth |
| Garmin HRM-Pro | HR + breathing | ~$100 | Alternative |
| Pulse oximeter (clip) | SpO2 + HR | ~$20 | HR only, less accurate |
| Apple Watch (if you have one) | HR | $0 extra | HR only, 1 Hz |

The Polar H10 is recommended because it captures both breathing rate and heart rate simultaneously at high frequency (1000 Hz ECG, ~1 Hz breathing).

#### Data Collection

Run 2–4 hours of sessions wearing the Polar H10 while doing normal activities (sitting at a desk, watching TV, lying down, light walking). The backend logs CSI packets with timestamps; the Polar H10 sends HR/BR via Bluetooth to your phone with timestamps. Post-process to align and pair the two streams.

#### Model Architecture for Vitals

```python
class CSIVitalsNet(nn.Module):
    """Predicts breathing rate AND heart rate from a 10-second CSI phase window."""
    def __init__(self, n_subcarriers=52, window_frames=200):  # 200 frames @ 20 Hz = 10s
        super().__init__()
        self.encoder = nn.Sequential(
            nn.Conv1d(n_subcarriers, 64, kernel_size=7, padding=3),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.Conv1d(64, 128, kernel_size=5, padding=2),
            nn.BatchNorm1d(128),
            nn.ReLU(),
            nn.Conv1d(128, 64, kernel_size=3, padding=1),
            nn.ReLU(),
        )
        self.lstm = nn.LSTM(64, 128, num_layers=2, batch_first=True, dropout=0.2)
        self.br_head = nn.Linear(128, 1)   # breathing rate BPM
        self.hr_head = nn.Linear(128, 1)   # heart rate BPM

    def forward(self, x):  # x: (batch, window_frames, n_subcarriers)
        x = x.permute(0, 2, 1)                # (batch, n_sub, frames)
        feat = self.encoder(x)                # (batch, 64, frames)
        feat = feat.permute(0, 2, 1)          # (batch, frames, 64)
        _, (h, _) = self.lstm(feat)
        return self.br_head(h[-1]), self.hr_head(h[-1])
```

**Expected accuracy after training:**
- Breathing rate: ±1–2 BPM (vs current ±4–6 BPM from zero-crossing)
- Heart rate: ±4–6 BPM (vs current ±8–15 BPM, frequently failing)

---

### Tier 4 — Hardware Upgrades (~$50–$300)

#### 4A. 5 GHz Band (High Priority, ~$0 if you have a dual-band router)

5 GHz WiFi gives 52–56 subcarriers per 20 MHz channel vs ~30 for 2.4 GHz, and the shorter wavelength (6 cm vs 12 cm) is more sensitive to fine motion. The heart signal involves ~1 mm chest displacement — at 5 GHz this produces a phase shift of ~12°, vs ~6° at 2.4 GHz. This alone roughly doubles the cardiac SNR.

**To enable:** your AP must broadcast on 5 GHz, and the ESP32-C6 supports 5 GHz natively (ESP32-S3 does not — use C6 nodes for 5 GHz).

#### 4B. More Nodes (Medium Priority, ~$15–$25 per node)

Three nodes provide 2D trilateration with a large blind spot directly between them. Adding a 4th node (room center, or 4th corner) improves geometric diversity significantly.

For the ML approach (Tier 2), more nodes = more views = better position accuracy. The CNN model can take multi-node CSI as separate input channels.

#### 4C. External Antennas (Lower Priority, ~$10–$30)

The ESP32's onboard PCB antenna has ~0 dBi gain and poor pattern uniformity. A directional 3 dBi external antenna aimed at the room center increases the useful signal and reduces the angular blind spots.

#### 4D. mmWave Fusion (Optional, ~$100–$150)

The firmware already has `mmwave_sensor.c` — support for an optional 60 GHz millimeter-wave radar sensor. A dedicated 60 GHz board (like the Texas Instruments IWR6843 or Acconeer A121) can measure chest displacement with sub-millimeter precision, making breathing/HR estimation dramatically more reliable. This can be fused with WiFi CSI for best-of-both: WiFi for coarse presence/position, mmWave for precise vitals.

---

### Tier 5 — Person-Specific Enrollment

Just as fingerprint readers enroll each person once, WiFi CSI sensing can be adapted to a specific person's body. Body composition (fat %, muscle mass, height) affects how strongly a person reflects/absorbs WiFi signals. A 5-minute enrollment session — where the person stands still, breathes deeply, walks a defined path — can:

1. Calibrate the RSSI-to-distance model for their body's reflectivity
2. Set a baseline breathing rate prior for the BPM estimator (a more constrained search window)
3. Build a person-specific CSI "signature" for re-identification (e.g., to distinguish two people in the same room)

---

## 6. Implementation Plan — What to Do and In What Order

### Phase 1 — This Week (Software Only, Free)

| Task | File | Expected Gain |
|------|------|---------------|
| Add phase sanitization to `_handle_csi_frame` | `csi_bridge.py` | ×2 SNR for all downstream processing |
| Replace zero-crossing BPM with MUSIC algorithm in backend | `csi_bridge.py` | ±1–2 BPM breathing accuracy |
| Run empty-room calibration and set dynamic presence threshold | `csi_bridge.py` | Eliminate HVAC false positives |
| Add PCA subcarrier selection | `csi_bridge.py` | Better signal isolation |

### Phase 2 — Next 2 Weeks (Camera Training)

| Task | What You Need | Expected Gain |
|------|--------------|---------------|
| Buy/borrow a USB webcam | ~$20 on Amazon | Training only, removed afterward |
| Write data collection script | `backend/collect_data.py` | Paired CSI + position labels |
| Collect 1–2 hours of movement data | 1–2 hours of your time | Training dataset |
| Train `CSIPositionNet` | Any laptop with Python + PyTorch | ±0.3 m position accuracy |
| Swap trilateration for model inference | `csi_bridge.py` | 4–6× position improvement |

### Phase 3 — Weeks 3–5 (Vitals Model)

| Task | What You Need | Expected Gain |
|------|--------------|---------------|
| Buy Polar H10 or similar | ~$80 | Ground-truth HR + breathing |
| Collect 2–4 hours of paired data | Your time | Training dataset |
| Add phase sanitization to CSI pipeline | Done in Phase 1 | Better input features |
| Train `CSIVitalsNet` | Laptop + PyTorch | ±2 BPM BR, ±5 BPM HR |
| Deploy model in backend | `csi_bridge.py` | Replace bandpass estimator |

### Phase 4 — Hardware (Optional, When Budget Allows)

| Upgrade | Cost | Impact |
|---------|------|--------|
| 4th ESP32-C6 node | ~$15 | Better geometry for position |
| Use 5 GHz band (C6 nodes required) | $0 extra | ×2 cardiac SNR |
| External antennas per node | ~$10/node | More uniform coverage |
| mmWave sensor (e.g., Acconeer A121) | ~$100 | Sub-mm vitals accuracy |

---

## Summary

| Approach | Cost | Time | Position Accuracy | BR Accuracy | HR Accuracy |
|----------|------|------|-------------------|-------------|-------------|
| **Current system** | — | — | ±1–3 m (zone grid) | ±4–6 BPM | ±8–15 BPM, often fails |
| + Phase sanitization + MUSIC | $0 | 2 days | ±1–3 m | ±2–3 BPM | ±5–8 BPM |
| + Camera training (removed after) | ~$20 | 2 weeks | **±0.3–0.5 m** | ±2–3 BPM | ±5–8 BPM |
| + Polar H10 vitals model | ~$80 | 3–5 weeks | ±0.3–0.5 m | **±1–2 BPM** | **±3–5 BPM** |
| + 5 GHz + mmWave | ~$150 | 6+ weeks | ±0.3–0.5 m | **±0.5–1 BPM** | **±1–2 BPM** |

The camera-assisted position training and phase sanitization give the biggest accuracy jump for the lowest cost and should be prioritized first.
