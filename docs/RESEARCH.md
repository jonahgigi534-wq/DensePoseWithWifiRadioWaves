# Research notes

Notes from building and debugging the presence sensor: how the signal behaves, what worked, what didn't, and what would improve it. The numbers come from three ESP32-S3 nodes in one room.

## The signal

WiFi (802.11n) splits each channel into many narrow subcarriers. For every frame it receives, the ESP32 reports a complex value for each subcarrier, giving the amplitude and phase the signal arrived with. That list is the Channel State Information (CSI). People change how the signal bounces around a room, so they change the CSI. RSSI, the single signal-strength number every WiFi device reports, is a much coarser version of the same information.

CSI only arrives when the router sends a frame. On these boards that worked out to about 13 to 19 frames per second, not the 100 Hz the firmware is designed for, so the backend can't assume a fixed sample rate.

## Presence detection

### The first version measured noise

The first version averaged the amplitude across all subcarriers in each frame and watched how that single number varied. It didn't work. With logging on every node, an empty room and an occupied room gave the same reading, roughly 0.6 to 0.85 on the motion scale in both cases.

There were two reasons. Averaging across subcarriers throws the useful information away, because a person (especially one sitting still) changes a few subcarriers, not all of them. And the ESP32's automatic gain control rescales whole frames from packet to packet, so most of the variation in the average was gain changes rather than people.

### What works

1. Divide each frame by its own mean amplitude. That cancels the gain changes and keeps the shape of the channel across subcarriers.
2. For each subcarrier, take the standard deviation over the last 60 frames.
3. Use the 90th percentile across subcarriers as the motion metric, so the handful of subcarriers that react to a person drive the result.
4. Compare that against a baseline kept separately for each node. The baseline moves down quickly and up slowly, so it settles at the empty-room level and someone sitting in the room only drags it up gradually. A node counts the room as occupied when the metric is more than twice its baseline and above 0.12, for four frames in a row.

On the real nodes, one node read about 0.45 with someone sitting still next to it, and another read about 0.08 with the room empty. Those readings came from different nodes, so the ratio between them is rough, but the first approach couldn't separate the two cases at all.

Two things came out of testing:

- Placement matters a lot. A third node barely reacted to a person standing elsewhere in the room (0.098, against 0.078 when empty). A person is easiest to detect when they're between a node and the router.
- The backend should start with the room empty. The baseline is seeded from the first frames, so anyone in the room at start-up becomes part of the baseline and isn't detected until they leave once.

### The firmware's presence flag

The vitals packet from the firmware has a presence bit. During testing it never turned on, even with someone standing in the room. An earlier version of the backend trusted the vitals packets, and the room stayed "occupied" indefinitely after everyone left, because the firmware kept sending plausible-looking vitals. Presence now comes only from the CSI metric above.

### Open problem: false re-triggers

After clearing, the room can flip back to occupied a few seconds later with nobody there. One attempt to fix it required sustained motion before switching on and only adapted the baseline while the room was empty. That stopped detection working at all, since a person in the room at start-up became the baseline, so it was reverted. The likely causes are WiFi channel hopping or something moving near a node. Locking every node to one channel is the first thing to try.

## Breathing and heart rate

The firmware estimates both by band-pass filtering the CSI phase (0.1-0.5 Hz for breathing, 0.8-2.0 Hz for heart rate) and counting zero crossings. On this hardware the output is noise. With nobody in the room it still reported breathing rates between 15 and 39 a minute and heart rates between 45 and 110 bpm.

The reasons are physical:

- A heartbeat moves the chest about 0.2-0.5 mm, around a hundred times less than breathing does, and harmonics of the breathing rate fall inside the heart-rate band.
- The ESP32's CSI phase is corrupted by carrier frequency and timing offsets, and the backend only uses amplitude.
- With one antenna per board there's no way to separate signals by the direction they arrive from.

## Position

Each node's RSSI goes through a log-distance path-loss model (-40 dBm at 1 m, exponent 3.0) to get a distance. With two nodes the backend intersects the two circles; with three or more it takes an inverse-distance weighted average of the node positions. The result is smoothed twice: an exponential moving average in the backend (weight 0.15) and a Kalman filter on each axis in the browser. Accuracy is around 1-2 m.

## The pre-trained model

RuView links a pre-trained model on Hugging Face. Its model card describes ONNX files and a head that outputs breathing and heart rate, but the repository has neither. The actual files are a small encoder (8 inputs, 64 hidden units, a 128-value output) and one presence head. Run on real feature vectors, the presence head said "occupied" for every input, empty room included, because of a large bias term (+8.19). It isn't used.

## What would improve it

Roughly from cheapest to most expensive:

- Lock every node to one WiFi channel. It's free, and it's the most likely fix for the false re-triggers.
- Recover usable CSI phase in software: multiply each subcarrier by the complex conjugate of its neighbour to cancel the timing offset, then remove the remaining linear trend across subcarriers. That could make breathing detection work for someone sitting still.
- Estimate the breathing rate from a spectrum (an FFT peak, or MUSIC) over 30-60 seconds instead of counting zero crossings.
- Add nodes (about $9 per ESP32-S3) for better coverage and position.
- Add a 60 GHz mmWave radar such as the Seeed MR60BHA2 (around $20) for breathing and heart rate. The firmware already defines a packet that merges mmWave and CSI vitals (`0xC5110004`). This is the realistic route to a usable heart rate.
- Use a WiFi card that reports CSI from several antennas, such as an Intel 5300 with the Linux 802.11n CSI Tool. Several antennas give an angle of arrival, which is what a precise position needs.
- Train a model to map CSI to position. A camera would only be needed while collecting the training data, to record where the person was actually standing.
