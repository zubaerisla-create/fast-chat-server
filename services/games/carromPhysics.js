/**
 * Carrom board physics: frictional sliding discs, disc–disc and disc–cushion collisions and
 * corner pockets, simulated with a fixed time step.
 *
 * Kept deliberately small (no Matter.js): a carrom board is ~20 circles in a box, and a
 * hand-written integrator uses only + − × ÷ and √ (no trigonometry), so the server result is
 * reproducible and the app's TypeScript copy (game/mini/carrom/physics.ts) behaves the same.
 * Keep the two files in step — both test suites check the same reference shot.
 *
 * Units are millimetres of a standard 74 cm board; speeds are mm/s.
 */
const BOARD = 740;
const COIN_R = 15.9; // 31.8 mm coins
const STRIKER_R = 20.6; // 41.3 mm striker
const COIN_M = 1;
const STRIKER_M = 2.7; // 15 g striker vs 5.5 g coins
const POCKET_R = 22.5; // 44.5 mm pockets
const POCKET_INSET = 24;
const POCKETS = [
  [POCKET_INSET, POCKET_INSET],
  [BOARD - POCKET_INSET, POCKET_INSET],
  [POCKET_INSET, BOARD - POCKET_INSET],
  [BOARD - POCKET_INSET, BOARD - POCKET_INSET],
];
const BASELINE_OFFSET = 117; // distance of a baseline (striker centre) from its cushion
const BASE_Y = [BOARD - BASELINE_OFFSET, BASELINE_OFFSET]; // seat 0 plays from the bottom, seat 1 from the top
const STRIKER_MIN_X = 150;
const STRIKER_MAX_X = BOARD - 150;
const MAX_SPEED = 2400;
const MIN_POWER = 0.05;
const FRICTION = 520; // mm/s² deceleration (powdered board)
const REST_PIECE = 0.92;
const REST_WALL = 0.62;
const STOP_SPEED = 4;
const DT = 1 / 240;
const MAX_STEPS = 240 * 12;
const FRAME_EVERY = 8; // record a frame every 8 steps → 30 fps playback
const CENTER = BOARD / 2;

/** Ids: 0 striker, 1–9 white, 10–18 black, 19 queen. */
const kindOf = (id) => (id === 0 ? "striker" : id === 19 ? "queen" : id <= 9 ? "white" : "black");

/** Starting layout: queen in the centre, a ring of 6 and a ring of 12 around it (colours alternate). */
function initialPieces() {
  const pieces = [{ id: 19, x: CENTER, y: CENTER }];
  const d = 2 * COIN_R + 0.2;
  const s3 = Math.sqrt(3);
  // Inner ring: hexagon corners, unit vectors at 0°, 60° … written without trig
  const hex = [
    [1, 0], [0.5, s3 / 2], [-0.5, s3 / 2], [-1, 0], [-0.5, -s3 / 2], [0.5, -s3 / 2],
  ];
  // Outer ring: hexagon corners at 2d and edge midpoints at √3·d
  const mids = [
    [s3 / 2, 0.5], [0, 1], [-s3 / 2, 0.5], [-s3 / 2, -0.5], [0, -1], [s3 / 2, -0.5],
  ];
  const inner = hex.map(([x, y]) => [CENTER + x * d, CENTER + y * d]);
  const outer = [];
  for (let i = 0; i < 6; i++) {
    outer.push([CENTER + hex[i][0] * 2 * d, CENTER + hex[i][1] * 2 * d]);
    outer.push([CENTER + mids[i][0] * s3 * d, CENTER + mids[i][1] * s3 * d]);
  }
  let w = 1;
  let b = 10;
  inner.forEach(([x, y], i) => pieces.push({ id: i % 2 === 0 ? w++ : b++, x, y }));
  // Outer corners take the colour of the inner coin in front of them; the midpoints alternate
  outer.forEach(([x, y], i) => {
    const corner = i % 2 === 0;
    const white = corner ? (i / 2) % 2 === 0 : ((i - 1) / 2) % 2 === 1;
    pieces.push({ id: white ? w++ : b++, x, y });
  });
  return pieces;
}

const q = (v) => Math.round(v * 2); // half-millimetre precision for playback frames

/**
 * Simulates one shot. `pieces` are the coins on the board ({id, x, y}); the striker starts at
 * (x, BASE_Y[seat]) moving along (dx, dy) with `power` ∈ [MIN_POWER, 1].
 * Returns final coin positions, what was pocketed, and compact playback data.
 */
function simulate(pieces, { seat, x, dx, dy, power }) {
  const len = Math.sqrt(dx * dx + dy * dy);
  const speed = MAX_SPEED * power;
  const bodies = [
    { id: 0, x, y: BASE_Y[seat], vx: (dx / len) * speed, vy: (dy / len) * speed, r: STRIKER_R, m: STRIKER_M, on: true },
    ...pieces.map((p) => ({ id: p.id, x: p.x, y: p.y, vx: 0, vy: 0, r: COIN_R, m: COIN_M, on: true })),
  ];
  const frames = [];
  const events = [];
  const pocketed = [];
  const last = new Map(bodies.map((b) => [b.id, [q(b.x), q(b.y)]]));
  frames.push(bodies.flatMap((b) => [b.id, q(b.x), q(b.y)]));
  let step = 0;

  for (; step < MAX_STEPS; step++) {
    let moving = false;
    // Integrate with friction
    for (const b of bodies) {
      if (!b.on) continue;
      const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (v === 0) continue;
      const nv = v - FRICTION * DT;
      if (nv <= STOP_SPEED) {
        b.vx = 0;
        b.vy = 0;
        continue;
      }
      b.vx = (b.vx / v) * nv;
      b.vy = (b.vy / v) * nv;
      b.x += b.vx * DT;
      b.y += b.vy * DT;
      moving = true;
    }

    // Disc–disc collisions (fixed order → deterministic)
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (!a.on) continue;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (!b.on) continue;
        const nx = b.x - a.x;
        const ny = b.y - a.y;
        const min = a.r + b.r;
        const d2 = nx * nx + ny * ny;
        if (d2 >= min * min || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const ux = nx / d;
        const uy = ny / d;
        // Push apart in proportion to the other body's mass
        const overlap = min - d;
        const total = a.m + b.m;
        a.x -= ux * overlap * (b.m / total);
        a.y -= uy * overlap * (b.m / total);
        b.x += ux * overlap * (a.m / total);
        b.y += uy * overlap * (a.m / total);
        const rel = (a.vx - b.vx) * ux + (a.vy - b.vy) * uy;
        if (rel <= 0) continue; // already separating
        const impulse = ((1 + REST_PIECE) * rel) / (1 / a.m + 1 / b.m);
        a.vx -= (impulse / a.m) * ux;
        a.vy -= (impulse / a.m) * uy;
        b.vx += (impulse / b.m) * ux;
        b.vy += (impulse / b.m) * uy;
        moving = true;
        if (rel > 40) events.push({ t: step, type: "hit", a: a.id, b: b.id, v: Math.round(rel) });
      }
    }

    // Cushions and pockets
    for (const b of bodies) {
      if (!b.on) continue;
      let hit = 0;
      if (b.x < b.r) {
        b.x = b.r;
        if (b.vx < 0) {
          hit = -b.vx;
          b.vx = -b.vx * REST_WALL;
          b.vy *= 0.96;
        }
      } else if (b.x > BOARD - b.r) {
        b.x = BOARD - b.r;
        if (b.vx > 0) {
          hit = b.vx;
          b.vx = -b.vx * REST_WALL;
          b.vy *= 0.96;
        }
      }
      if (b.y < b.r) {
        b.y = b.r;
        if (b.vy < 0) {
          hit = Math.max(hit, -b.vy);
          b.vy = -b.vy * REST_WALL;
          b.vx *= 0.96;
        }
      } else if (b.y > BOARD - b.r) {
        b.y = BOARD - b.r;
        if (b.vy > 0) {
          hit = Math.max(hit, b.vy);
          b.vy = -b.vy * REST_WALL;
          b.vx *= 0.96;
        }
      }
      if (hit > 60) events.push({ t: step, type: "wall", a: b.id, v: Math.round(hit) });
      for (let p = 0; p < 4; p++) {
        const px = b.x - POCKETS[p][0];
        const py = b.y - POCKETS[p][1];
        if (px * px + py * py <= POCKET_R * POCKET_R) {
          b.on = false;
          b.vx = 0;
          b.vy = 0;
          b.x = POCKETS[p][0];
          b.y = POCKETS[p][1];
          pocketed.push(b.id);
          events.push({ t: step, type: "pocket", a: b.id, pocket: p });
          break;
        }
      }
    }

    if (step % FRAME_EVERY === FRAME_EVERY - 1 || !moving) {
      const frame = [];
      for (const b of bodies) {
        const pos = [q(b.x), q(b.y)];
        const prev = last.get(b.id);
        if (pos[0] !== prev[0] || pos[1] !== prev[1]) {
          frame.push(b.id, pos[0], pos[1]);
          last.set(b.id, pos);
        }
      }
      frames.push(frame);
    }
    if (!moving) break;
  }

  // Event times → frame indexes for playback
  for (const e of events) e.f = Math.min(frames.length - 1, Math.ceil((e.t + 1) / FRAME_EVERY));
  const durationMs = Math.round(((frames.length - 1) * FRAME_EVERY * DT) * 1000);
  return {
    pieces: bodies.filter((b) => b.id !== 0 && b.on).map((b) => ({ id: b.id, x: b.x, y: b.y })),
    pocketed,
    strikerPocketed: pocketed.includes(0),
    strikerEnd: { x: bodies[0].x, y: bodies[0].y },
    frames,
    events: thinEvents(events).map(({ f, type, a, b, v, pocket }) => ({ f, type, a, b, v, pocket })),
    frameMs: Math.round(FRAME_EVERY * DT * 1000 * 1000) / 1000,
    durationMs,
    steps: step,
  };
}

/** At most one sound per frame and kind, so a break shot doesn't play 40 clicks at once. */
function thinEvents(events) {
  const seen = new Set();
  return events.filter((e) => {
    if (e.type === "pocket") return true;
    const key = `${e.f}:${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** True when a striker at (x, BASE_Y[seat]) would overlap a coin. */
function strikerBlocked(pieces, seat, x) {
  const y = BASE_Y[seat];
  const min = STRIKER_R + COIN_R;
  return pieces.some((p) => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < min * min);
}

/** Free spot nearest the centre for a coin coming back onto the board (deterministic spiral). */
function freeSpot(pieces) {
  const min = 2 * COIN_R + 0.5;
  const free = (x, y) => pieces.every((p) => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) >= min * min);
  if (free(CENTER, CENTER)) return { x: CENTER, y: CENTER };
  for (let ring = 1; ring < 40; ring++) {
    const rad = ring * 6;
    const n = 8 * ring;
    // Points on a square spiral around the centre — no trig needed
    for (let k = 0; k < n; k++) {
      const side = Math.floor(k / (2 * ring));
      const off = (k % (2 * ring)) - ring;
      const [ox, oy] = side === 0 ? [off, -ring] : side === 1 ? [ring, off] : side === 2 ? [-off, ring] : [-ring, -off];
      const x = CENTER + (ox * rad) / ring;
      const y = CENTER + (oy * rad) / ring;
      if (free(x, y)) return { x, y };
    }
  }
  return { x: CENTER, y: CENTER };
}

module.exports = {
  BOARD,
  COIN_R,
  STRIKER_R,
  POCKET_R,
  POCKETS,
  BASE_Y,
  STRIKER_MIN_X,
  STRIKER_MAX_X,
  MAX_SPEED,
  MIN_POWER,
  CENTER,
  kindOf,
  initialPieces,
  simulate,
  strikerBlocked,
  freeSpot,
};
