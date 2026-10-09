# Dashboard

The web dashboard for wifi-csi-presence-sensing, built with React, Vite and Three.js. It shows how many nodes are online, the motion level, the vitals readout, and a 3D view of the room with a marker at the person's estimated position.

## Running

Start the backend first (it runs on port 4000), then:

```bash
npm install
npm run dev
```

and open http://localhost:5173. The Vite dev server forwards `/api` and `/ws` to the backend; see `vite.config.js`.

`npm run build` writes a production build to `dist/`.

## Where things are

- `src/hooks/useRuView.js`: the WebSocket connection to the backend, message parsing, and position smoothing (a Kalman filter on each axis)
- `src/components/Room3D.jsx`: the 3D room and the person marker
- `src/pages/`: the Dashboard, Insights and Training pages
