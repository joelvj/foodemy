"use client";

import React, { useEffect, useRef, useState } from "react";

/*
 * Classic Asteroids, rebuilt for the browser with mobile touch controls.
 *
 * Feature parity with the 1979 arcade game:
 *  - Ship with rotation, thrust + inertia, screen wrap
 *  - Asteroids in 3 sizes that split (large -> 2 medium -> 2 small)
 *  - Max 4 player bullets on screen, bullets inherit ship velocity
 *  - Large saucer (fires randomly) and small saucer (aims at the player,
 *    accuracy improves with score), saucer bullets break asteroids
 *  - Classic scoring: 20 / 50 / 100 for asteroids, 200 / 1000 for saucers
 *  - Extra life every 10,000 points, hyperspace with self-destruct risk
 *  - Waves grow (4, 6, 8, 10, 11 asteroids) and speed up
 *  - Heartbeat that accelerates as a wave empties, thrust / fire /
 *    explosion / saucer-siren sounds (WebAudio, no assets)
 *  - Safe respawn, invulnerability blink, high score in localStorage
 */

type RockSize = 0 | 1 | 2; // 0 = large, 1 = medium, 2 = small

interface Rock {
  x: number; y: number; vx: number; vy: number;
  size: RockSize; r: number;
  shape: number[]; rot: number; rotV: number;
}
interface Bullet {
  x: number; y: number; vx: number; vy: number;
  life: number; fromShip: boolean;
}
interface Saucer {
  x: number; y: number; vx: number; vy: number;
  small: boolean; r: number; fireT: number; dirT: number; exitDir: number;
}
interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; len: number; a: number; spin: number;
}

const ROCK_R = [52, 27, 14]; // radii per size, in game units
const ROCK_SCORE = [20, 50, 100];
const ROCK_SPEED = [70, 115, 165];
const SHIP_R = 13;
const TURN_SPEED = 4.3; // rad/s
const THRUST = 330;
const MAX_SPEED = 470;
const BULLET_SPEED = 620;
const BULLET_LIFE = 1.05;
const MAX_BULLETS = 4;
const SAUCER_SCORE = { big: 200, small: 1000 };
const EXTRA_LIFE_EVERY = 10000;
const HS_KEY = "asteroids-highscore";

interface Ship {
  x: number; y: number; a: number; vx: number; vy: number;
  dead: boolean; inv: number; hyperT: number; hyperCd: number;
}

interface GameState {
  mode: "title" | "playing" | "over";
  w: number; h: number; u: number;
  score: number; high: number; lives: number; wave: number; nextLifeAt: number;
  ship: Ship;
  rocks: Rock[]; bullets: Bullet[]; parts: Particle[];
  saucer: Saucer | null; saucerT: number;
  respawnT: number; waveT: number; overT: number; restartLock: number;
  waveRockCount: number;
  firePrev: boolean; fireHold: number; hyperPrev: boolean;
  beatT: number; beatHi: boolean;
  paused: boolean; time: number;
}

interface InputState {
  left: boolean; right: boolean; thrust: boolean; fire: boolean; hyper: boolean;
}

interface AudioState {
  ctx: AudioContext | null;
  master: GainNode | null;
  thrustGain: GainNode | null;
  saucerOsc: OscillatorNode | null;
  saucerGain: GainNode | null;
  saucerLfo: OscillatorNode | null;
}

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

function wrap(o: { x: number; y: number }, w: number, h: number, m: number) {
  if (o.x < -m) o.x += w + m * 2;
  if (o.x > w + m) o.x -= w + m * 2;
  if (o.y < -m) o.y += h + m * 2;
  if (o.y > h + m) o.y -= h + m * 2;
}

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

function makeShape(): number[] {
  const n = 10 + Math.floor(Math.random() * 3);
  const s: number[] = [];
  for (let i = 0; i < n; i++) s.push(rand(0.72, 1.12));
  return s;
}

export default function AsteroidsGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<InputState>({ left: false, right: false, thrust: false, fire: false, hyper: false });
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  mutedRef.current = muted;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let high = 0;
    try { high = parseInt(localStorage.getItem(HS_KEY) || "0", 10) || 0; } catch { /* private mode */ }

    const G: GameState = {
      mode: "title", w: 0, h: 0, u: 1,
      score: 0, high, lives: 0, wave: 0, nextLifeAt: EXTRA_LIFE_EVERY,
      ship: { x: 0, y: 0, a: -Math.PI / 2, vx: 0, vy: 0, dead: true, inv: 0, hyperT: 0, hyperCd: 0 },
      rocks: [], bullets: [], parts: [],
      saucer: null, saucerT: 12,
      respawnT: 0, waveT: 0, overT: 0, restartLock: 0,
      waveRockCount: 1,
      firePrev: false, fireHold: 0, hyperPrev: false,
      beatT: 1, beatHi: false,
      paused: false, time: 0,
    };

    const A: AudioState = { ctx: null, master: null, thrustGain: null, saucerOsc: null, saucerGain: null, saucerLfo: null };

    // ---------- audio ----------
    function initAudio() {
      if (A.ctx) {
        if (A.ctx.state === "suspended") A.ctx.resume();
        return;
      }
      try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        A.ctx = new Ctx();
      } catch { return; }
      const ac = A.ctx;
      A.master = ac.createGain();
      A.master.gain.value = 0.5;
      A.master.connect(ac.destination);

      // looping thrust rumble (filtered noise), gated per frame
      const len = ac.sampleRate;
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ac.createBufferSource();
      src.buffer = buf; src.loop = true;
      const bp = ac.createBiquadFilter();
      bp.type = "lowpass"; bp.frequency.value = 320;
      A.thrustGain = ac.createGain();
      A.thrustGain.gain.value = 0;
      src.connect(bp).connect(A.thrustGain).connect(A.master);
      src.start();

      // saucer siren: triangle warbled by an LFO, gated per frame
      A.saucerOsc = ac.createOscillator();
      A.saucerOsc.type = "triangle";
      A.saucerOsc.frequency.value = 220;
      A.saucerLfo = ac.createOscillator();
      A.saucerLfo.type = "square";
      A.saucerLfo.frequency.value = 5;
      const lfoGain = ac.createGain();
      lfoGain.gain.value = 60;
      A.saucerLfo.connect(lfoGain).connect(A.saucerOsc.frequency);
      A.saucerGain = ac.createGain();
      A.saucerGain.gain.value = 0;
      A.saucerOsc.connect(A.saucerGain).connect(A.master);
      A.saucerOsc.start();
      A.saucerLfo.start();
    }

    function sfxOk() {
      return !!A.ctx && !mutedRef.current;
    }

    function blip(freq: number, endFreq: number, dur: number, type: OscillatorType, vol: number, when = 0) {
      if (!sfxOk() || !A.ctx || !A.master) return;
      const ac = A.ctx;
      const t = ac.currentTime + when;
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(A.master);
      o.start(t);
      o.stop(t + dur + 0.02);
    }

    function noiseBurst(dur: number, cutoff: number, vol: number) {
      if (!sfxOk() || !A.ctx || !A.master) return;
      const ac = A.ctx;
      const len = Math.floor(ac.sampleRate * dur);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ac.createBufferSource();
      src.buffer = buf;
      const f = ac.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = cutoff;
      const g = ac.createGain();
      g.gain.value = vol;
      src.connect(f).connect(g).connect(A.master);
      src.start();
    }

    const sfx = {
      fire: () => blip(900, 200, 0.14, "square", 0.16),
      saucerFire: () => blip(500, 120, 0.18, "sawtooth", 0.12),
      boomBig: () => noiseBurst(0.65, 500, 0.75),
      boomMed: () => noiseBurst(0.45, 900, 0.6),
      boomSmall: () => noiseBurst(0.3, 1600, 0.5),
      shipBoom: () => noiseBurst(0.9, 400, 0.9),
      hyper: () => blip(200, 1400, 0.25, "sine", 0.2),
      beat: (hi: boolean) => blip(hi ? 66 : 54, hi ? 66 : 54, 0.11, "sine", 0.55),
      extraLife: () => { for (let i = 0; i < 5; i++) blip(980, 980, 0.09, "square", 0.18, i * 0.13); },
    };

    // ---------- sizing ----------
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth, h = window.innerHeight;
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      canvas!.style.width = w + "px";
      canvas!.style.height = h + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      G.w = w; G.h = h;
      G.u = Math.min(w, h) / 760;
    }
    resize();

    // ---------- spawning ----------
    function spawnRock(size: RockSize, x: number, y: number, speedMul = 1): Rock {
      const ang = rand(0, Math.PI * 2);
      const sp = ROCK_SPEED[size] * rand(0.6, 1.25) * speedMul * (1 + Math.min(0.5, (G.wave - 1) * 0.07)) * G.u;
      return {
        x, y,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        size, r: ROCK_R[size] * G.u,
        shape: makeShape(), rot: rand(0, Math.PI * 2), rotV: rand(-1.2, 1.2),
      };
    }

    function spawnWaveRocks(count: number) {
      for (let i = 0; i < count; i++) {
        // spawn on an edge, away from the ship
        let x: number, y: number, tries = 0;
        do {
          if (Math.random() < 0.5) {
            x = Math.random() < 0.5 ? 0 : G.w;
            y = rand(0, G.h);
          } else {
            x = rand(0, G.w);
            y = Math.random() < 0.5 ? 0 : G.h;
          }
          tries++;
        } while (dist2(x, y, G.ship.x, G.ship.y) < (240 * G.u) ** 2 && tries < 30);
        G.rocks.push(spawnRock(0, x, y));
      }
    }

    function startWave() {
      G.wave++;
      const count = Math.min(11, 4 + (G.wave - 1) * 2);
      G.waveRockCount = count * 7; // large=4+2+... total fragments: 1 large -> 7 kills
      spawnWaveRocks(count);
      G.saucerT = rand(9, 16);
      G.beatT = 1;
    }

    function startGame() {
      G.score = 0;
      G.lives = 3;
      G.wave = 0;
      G.nextLifeAt = EXTRA_LIFE_EVERY;
      G.rocks = [];
      G.bullets = [];
      G.parts = [];
      G.saucer = null;
      G.mode = "playing";
      G.paused = false;
      G.ship.x = G.w / 2; G.ship.y = G.h / 2;
      G.ship.vx = 0; G.ship.vy = 0;
      G.ship.a = -Math.PI / 2;
      G.ship.dead = false;
      G.ship.inv = 2;
      G.ship.hyperT = 0; G.ship.hyperCd = 0;
      startWave();
    }

    function spawnSaucer() {
      const small = Math.random() < Math.min(0.85, 0.2 + G.score / 30000);
      const r = (small ? 12 : 20) * G.u;
      const fromLeft = Math.random() < 0.5;
      const speed = (small ? 175 : 130) * G.u;
      G.saucer = {
        x: fromLeft ? -r : G.w + r,
        y: rand(G.h * 0.15, G.h * 0.85),
        vx: fromLeft ? speed : -speed,
        vy: 0,
        small, r,
        fireT: rand(0.5, 1),
        dirT: rand(0.8, 2),
        exitDir: fromLeft ? 1 : -1,
      };
      if (A.saucerOsc) A.saucerOsc.frequency.value = small ? 330 : 190;
      if (A.saucerLfo) A.saucerLfo.frequency.value = small ? 7 : 4.5;
    }

    // ---------- effects ----------
    function debris(x: number, y: number, n: number, sp: number, lines: boolean) {
      for (let i = 0; i < n; i++) {
        const ang = rand(0, Math.PI * 2);
        const v = rand(0.2, 1) * sp * G.u;
        G.parts.push({
          x, y,
          vx: Math.cos(ang) * v, vy: Math.sin(ang) * v,
          life: rand(0.4, lines ? 1.6 : 0.9), maxLife: 1,
          len: lines ? rand(4, 12) * G.u : 0,
          a: rand(0, Math.PI * 2), spin: rand(-4, 4),
        });
      }
    }

    function addScore(pts: number) {
      G.score += pts;
      if (G.score >= G.nextLifeAt) {
        G.nextLifeAt += EXTRA_LIFE_EVERY;
        G.lives++;
        sfx.extraLife();
      }
      if (G.score > G.high) {
        G.high = G.score;
      }
    }

    function killRock(idx: number, award: boolean) {
      const rk = G.rocks[idx];
      G.rocks.splice(idx, 1);
      if (award) addScore(ROCK_SCORE[rk.size]);
      if (rk.size === 0) sfx.boomBig();
      else if (rk.size === 1) sfx.boomMed();
      else sfx.boomSmall();
      debris(rk.x, rk.y, rk.size === 2 ? 6 : 10, 130, false);
      if (rk.size < 2) {
        const ns = (rk.size + 1) as RockSize;
        for (let i = 0; i < 2; i++) {
          const child = spawnRock(ns, rk.x, rk.y, 1);
          // bias children to keep some of the parent's motion
          child.vx = child.vx * 0.8 + rk.vx * 0.5;
          child.vy = child.vy * 0.8 + rk.vy * 0.5;
          G.rocks.push(child);
        }
      }
    }

    function killSaucer(award: boolean) {
      const s = G.saucer;
      if (!s) return;
      if (award) addScore(s.small ? SAUCER_SCORE.small : SAUCER_SCORE.big);
      debris(s.x, s.y, 12, 150, false);
      sfx.boomMed();
      G.saucer = null;
      G.saucerT = rand(8, 15);
    }

    function destroyShip() {
      if (G.ship.dead) return;
      G.ship.dead = true;
      sfx.shipBoom();
      debris(G.ship.x, G.ship.y, 14, 120, true);
      G.lives--;
      if (G.lives <= 0) {
        G.overT = 1.2;
      } else {
        G.respawnT = 2.2;
      }
    }

    function fireShipBullet() {
      const shipBullets = G.bullets.filter((b) => b.fromShip).length;
      if (shipBullets >= MAX_BULLETS) return;
      const s = G.ship;
      const nose = SHIP_R * G.u;
      G.bullets.push({
        x: s.x + Math.cos(s.a) * nose,
        y: s.y + Math.sin(s.a) * nose,
        vx: Math.cos(s.a) * BULLET_SPEED * G.u + s.vx,
        vy: Math.sin(s.a) * BULLET_SPEED * G.u + s.vy,
        life: BULLET_LIFE, fromShip: true,
      });
      sfx.fire();
    }

    function hyperspace() {
      const s = G.ship;
      if (s.dead || s.hyperT > 0 || s.hyperCd > 0) return;
      sfx.hyper();
      s.hyperT = 0.6;
      s.hyperCd = 1.5;
    }

    // ---------- update ----------
    function update(dt: number) {
      const inp = inputRef.current;
      G.time += dt;
      if (G.restartLock > 0) G.restartLock -= dt;

      // particles always animate (title screen uses them too)
      for (let i = G.parts.length - 1; i >= 0; i--) {
        const p = G.parts[i];
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.a += p.spin * dt;
        p.life -= dt;
        if (p.life <= 0) G.parts.splice(i, 1);
      }

      if (G.mode === "title") {
        // ambient drifting rocks behind the title
        if (G.rocks.length < 6) {
          G.wave = 1;
          G.rocks.push(spawnRock((Math.floor(Math.random() * 3)) as RockSize, rand(0, G.w), Math.random() < 0.5 ? -40 : G.h + 40));
        }
        for (const rk of G.rocks) {
          rk.x += rk.vx * dt; rk.y += rk.vy * dt; rk.rot += rk.rotV * dt;
          wrap(rk, G.w, G.h, rk.r);
        }
        return;
      }

      if (G.paused) return;

      const s = G.ship;

      // --- ship ---
      if (!s.dead) {
        if (s.hyperT > 0) {
          s.hyperT -= dt;
          if (s.hyperT <= 0) {
            s.x = rand(G.w * 0.1, G.w * 0.9);
            s.y = rand(G.h * 0.1, G.h * 0.9);
            s.vx = 0; s.vy = 0;
            if (Math.random() < 0.14) {
              destroyShip(); // classic hyperspace gamble
            }
          }
        } else {
          if (inp.left) s.a -= TURN_SPEED * dt;
          if (inp.right) s.a += TURN_SPEED * dt;
          if (inp.thrust) {
            s.vx += Math.cos(s.a) * THRUST * G.u * dt;
            s.vy += Math.sin(s.a) * THRUST * G.u * dt;
            const sp = Math.hypot(s.vx, s.vy);
            const max = MAX_SPEED * G.u;
            if (sp > max) { s.vx *= max / sp; s.vy *= max / sp; }
          }
          // gentle drag, like the original
          const drag = Math.exp(-0.45 * dt);
          s.vx *= drag; s.vy *= drag;
          s.x += s.vx * dt; s.y += s.vy * dt;
          wrap(s, G.w, G.h, SHIP_R * G.u);
        }
        if (s.inv > 0) s.inv -= dt;
        if (s.hyperCd > 0) s.hyperCd -= dt;

        // fire: shot per press, plus auto-fire while held (mobile-friendly)
        if (inp.fire && !G.firePrev) {
          fireShipBullet();
          G.fireHold = 0;
        } else if (inp.fire) {
          G.fireHold += dt;
          if (G.fireHold >= 0.22) {
            fireShipBullet();
            G.fireHold = 0;
          }
        }
        if (inp.hyper && !G.hyperPrev) hyperspace();
      } else if (G.mode === "playing" && G.lives > 0) {
        // waiting to respawn
        G.respawnT -= dt;
        if (G.respawnT <= 0) {
          const cx = G.w / 2, cy = G.h / 2;
          const clearR = (170 * G.u) ** 2;
          let safe = true;
          for (const rk of G.rocks) if (dist2(rk.x, rk.y, cx, cy) < clearR + rk.r * rk.r) { safe = false; break; }
          if (G.saucer && dist2(G.saucer.x, G.saucer.y, cx, cy) < clearR * 2) safe = false;
          for (const b of G.bullets) if (!b.fromShip && dist2(b.x, b.y, cx, cy) < clearR) { safe = false; break; }
          if (safe) {
            s.x = cx; s.y = cy; s.vx = 0; s.vy = 0; s.a = -Math.PI / 2;
            s.dead = false; s.inv = 2.5; s.hyperT = 0; s.hyperCd = 0;
          }
        }
      }
      G.firePrev = inp.fire;
      G.hyperPrev = inp.hyper;

      // --- game over transition ---
      if (G.lives <= 0 && G.overT > 0) {
        G.overT -= dt;
        if (G.overT <= 0) {
          G.mode = "over";
          G.restartLock = 0.8;
          try { localStorage.setItem(HS_KEY, String(G.high)); } catch { /* ignore */ }
        }
      }

      // --- rocks ---
      for (const rk of G.rocks) {
        rk.x += rk.vx * dt; rk.y += rk.vy * dt; rk.rot += rk.rotV * dt;
        wrap(rk, G.w, G.h, rk.r);
      }

      // --- bullets ---
      for (let i = G.bullets.length - 1; i >= 0; i--) {
        const b = G.bullets[i];
        b.x += b.vx * dt; b.y += b.vy * dt;
        b.life -= dt;
        wrap(b, G.w, G.h, 2);
        if (b.life <= 0) G.bullets.splice(i, 1);
      }

      // --- saucer ---
      if (G.saucer) {
        const sc = G.saucer;
        sc.x += sc.vx * dt; sc.y += sc.vy * dt;
        if (sc.y < -sc.r) sc.y += G.h + sc.r * 2;
        if (sc.y > G.h + sc.r) sc.y -= G.h + sc.r * 2;
        sc.dirT -= dt;
        if (sc.dirT <= 0) {
          sc.dirT = rand(0.9, 2.2);
          const spd = Math.abs(sc.vx);
          sc.vy = [0, -0.6, 0.6][Math.floor(Math.random() * 3)] * spd;
        }
        sc.fireT -= dt;
        if (sc.fireT <= 0 && !s.dead && s.hyperT <= 0) {
          sc.fireT = sc.small ? 0.8 : 1.0;
          let ang: number;
          if (sc.small) {
            ang = Math.atan2(s.y - sc.y, s.x - sc.x);
            const err = Math.max(0.04, 0.35 - G.score / 100000);
            ang += rand(-err, err);
          } else {
            ang = rand(0, Math.PI * 2);
          }
          const bs = 430 * G.u;
          G.bullets.push({
            x: sc.x, y: sc.y,
            vx: Math.cos(ang) * bs, vy: Math.sin(ang) * bs,
            life: 1.3, fromShip: false,
          });
          sfx.saucerFire();
        }
        // leaves on the far side (saucers don't wrap horizontally)
        if ((sc.exitDir === 1 && sc.x > G.w + sc.r) || (sc.exitDir === -1 && sc.x < -sc.r)) {
          G.saucer = null;
          G.saucerT = rand(8, 15);
        }
      } else if (G.mode === "playing" && G.lives > 0) {
        G.saucerT -= dt;
        if (G.saucerT <= 0) spawnSaucer();
      }

      // saucer siren gate
      if (A.saucerGain && A.ctx) {
        const want = G.saucer && !mutedRef.current && !G.paused ? 0.12 : 0;
        A.saucerGain.gain.setTargetAtTime(want, A.ctx.currentTime, 0.05);
      }
      // thrust rumble gate
      if (A.thrustGain && A.ctx) {
        const want = !s.dead && s.hyperT <= 0 && inp.thrust && !mutedRef.current && !G.paused ? 0.35 : 0;
        A.thrustGain.gain.setTargetAtTime(want, A.ctx.currentTime, 0.05);
      }

      // --- collisions ---
      // bullets vs rocks
      for (let i = G.bullets.length - 1; i >= 0; i--) {
        const b = G.bullets[i];
        let hit = -1;
        for (let j = 0; j < G.rocks.length; j++) {
          const rk = G.rocks[j];
          if (dist2(b.x, b.y, rk.x, rk.y) < rk.r * rk.r) { hit = j; break; }
        }
        if (hit >= 0) {
          G.bullets.splice(i, 1);
          killRock(hit, b.fromShip); // saucer shots break rocks but score nothing
        }
      }
      // ship bullets vs saucer / saucer bullets vs ship
      for (let i = G.bullets.length - 1; i >= 0; i--) {
        const b = G.bullets[i];
        if (b.fromShip) {
          if (G.saucer && dist2(b.x, b.y, G.saucer.x, G.saucer.y) < G.saucer.r * G.saucer.r) {
            G.bullets.splice(i, 1);
            killSaucer(true);
          }
        } else if (!s.dead && s.inv <= 0 && s.hyperT <= 0) {
          const rr = SHIP_R * G.u * 0.8;
          if (dist2(b.x, b.y, s.x, s.y) < rr * rr) {
            G.bullets.splice(i, 1);
            destroyShip();
          }
        }
      }
      // ship vs rocks (ramming still scores, as in the arcade)
      if (!s.dead && s.inv <= 0 && s.hyperT <= 0) {
        for (let j = G.rocks.length - 1; j >= 0; j--) {
          const rk = G.rocks[j];
          const rr = rk.r + SHIP_R * G.u * 0.7;
          if (dist2(s.x, s.y, rk.x, rk.y) < rr * rr) {
            killRock(j, true);
            destroyShip();
            break;
          }
        }
        if (G.saucer) {
          const rr = G.saucer.r + SHIP_R * G.u * 0.7;
          if (dist2(s.x, s.y, G.saucer.x, G.saucer.y) < rr * rr) {
            killSaucer(true);
            destroyShip();
          }
        }
      }
      // saucer vs rocks
      if (G.saucer) {
        for (let j = G.rocks.length - 1; j >= 0; j--) {
          const rk = G.rocks[j];
          const rr = rk.r + G.saucer.r;
          if (dist2(G.saucer.x, G.saucer.y, rk.x, rk.y) < rr * rr) {
            killRock(j, false);
            killSaucer(false);
            break;
          }
        }
      }

      // --- wave clear ---
      if (G.mode === "playing" && G.rocks.length === 0 && !G.saucer && G.lives > 0) {
        G.waveT += dt;
        if (G.waveT > 2) {
          G.waveT = 0;
          startWave();
        }
      } else {
        G.waveT = 0;
      }

      // --- heartbeat ---
      if (G.mode === "playing" && !s.dead && G.rocks.length > 0) {
        G.beatT -= dt;
        if (G.beatT <= 0) {
          let work = 0;
          for (const rk of G.rocks) work += [7, 3, 1][rk.size];
          const frac = Math.min(1, work / Math.max(1, G.waveRockCount));
          G.beatT = 0.28 + frac * 0.85;
          G.beatHi = !G.beatHi;
          sfx.beat(G.beatHi);
        }
      }
    }

    // ---------- drawing ----------
    function strokePoly(pts: number[][], x: number, y: number, a: number, close = true) {
      ctx!.save();
      ctx!.translate(x, y);
      ctx!.rotate(a);
      ctx!.beginPath();
      ctx!.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx!.lineTo(pts[i][0], pts[i][1]);
      if (close) ctx!.closePath();
      ctx!.stroke();
      ctx!.restore();
    }

    function drawShipAt(x: number, y: number, a: number, scale: number, flame: boolean) {
      const r = SHIP_R * scale;
      strokePoly(
        [
          [r, 0],
          [-r * 0.75, r * 0.6],
          [-r * 0.45, r * 0.32],
          [-r * 0.45, -r * 0.32],
          [-r * 0.75, -r * 0.6],
        ],
        x, y, a
      );
      if (flame && Math.random() < 0.85) {
        strokePoly(
          [
            [-r * 0.45, r * 0.28],
            [-r * (0.9 + Math.random() * 0.35), 0],
            [-r * 0.45, -r * 0.28],
          ],
          x, y, a, false
        );
      }
    }

    function drawSaucer(sc: Saucer) {
      const r = sc.r;
      strokePoly(
        [
          [-r, r * 0.25],
          [-r * 0.45, r * 0.6],
          [r * 0.45, r * 0.6],
          [r, r * 0.25],
          [r * 0.45, -r * 0.1],
          [-r * 0.45, -r * 0.1],
        ],
        sc.x, sc.y, 0
      );
      strokePoly(
        [
          [-r * 0.28, -r * 0.1],
          [-r * 0.18, -r * 0.5],
          [r * 0.18, -r * 0.5],
          [r * 0.28, -r * 0.1],
        ],
        sc.x, sc.y, 0, false
      );
      ctx!.beginPath();
      ctx!.moveTo(sc.x - r, sc.y + r * 0.25);
      ctx!.lineTo(sc.x + r, sc.y + r * 0.25);
      ctx!.stroke();
    }

    function drawRock(rk: Rock) {
      const n = rk.shape.length;
      const pts: number[][] = [];
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        const rr = rk.r * rk.shape[i];
        pts.push([Math.cos(ang) * rr, Math.sin(ang) * rr]);
      }
      strokePoly(pts, rk.x, rk.y, rk.rot);
    }

    function text(str: string, x: number, y: number, size: number, align: CanvasTextAlign = "center") {
      ctx!.font = `${Math.round(size)}px "Lucida Console", Monaco, monospace`;
      ctx!.textAlign = align;
      ctx!.fillText(str, x, y);
    }

    function draw() {
      const { w, h, u } = G;
      ctx!.fillStyle = "#000";
      ctx!.fillRect(0, 0, w, h);
      ctx!.strokeStyle = "#fff";
      ctx!.fillStyle = "#fff";
      ctx!.lineWidth = Math.max(1, 1.4 * u);
      ctx!.shadowColor = "rgba(160,200,255,0.55)";
      ctx!.shadowBlur = 6 * u;

      for (const rk of G.rocks) drawRock(rk);
      if (G.saucer) drawSaucer(G.saucer);

      for (const b of G.bullets) {
        ctx!.beginPath();
        ctx!.arc(b.x, b.y, 1.8 * u, 0, Math.PI * 2);
        ctx!.fill();
      }

      for (const p of G.parts) {
        ctx!.globalAlpha = Math.max(0, Math.min(1, p.life / 0.6));
        if (p.len > 0) {
          const dx = Math.cos(p.a) * p.len * 0.5, dy = Math.sin(p.a) * p.len * 0.5;
          ctx!.beginPath();
          ctx!.moveTo(p.x - dx, p.y - dy);
          ctx!.lineTo(p.x + dx, p.y + dy);
          ctx!.stroke();
        } else {
          ctx!.fillRect(p.x - 1, p.y - 1, 2, 2);
        }
        ctx!.globalAlpha = 1;
      }

      const s = G.ship;
      if (G.mode !== "title" && !s.dead && s.hyperT <= 0) {
        const blink = s.inv > 0 && Math.floor(G.time * 10) % 2 === 0;
        if (!blink) drawShipAt(s.x, s.y, s.a, u, inputRef.current.thrust);
      }

      // HUD
      ctx!.shadowBlur = 0;
      if (G.mode !== "title") {
        text(String(G.score).padStart(2, "0"), 18 * u, 34 * u, 26 * u, "left");
        text(String(G.high).padStart(2, "0"), w / 2, 30 * u, 16 * u);
        for (let i = 0; i < G.lives; i++) {
          drawShipAt(26 * u + i * 24 * u, 58 * u, -Math.PI / 2, 0.75 * u, false);
        }
      }

      if (G.mode === "title") {
        text("ASTEROIDS", w / 2, h * 0.32, 54 * u);
        text(`HIGH SCORE  ${G.high}`, w / 2, h * 0.42, 18 * u);
        if (Math.floor(G.time * 1.6) % 2 === 0) text("TAP OR PRESS ENTER TO START", w / 2, h * 0.55, 20 * u);
        text("ROTATE + THRUST + FIRE + HYPERSPACE", w / 2, h * 0.66, 13 * u);
        text("KEYS: ←/→ or A/D · ↑/W · SPACE · SHIFT/H", w / 2, h * 0.70, 13 * u);
        text("20 · 50 · 100 PTS — SAUCERS 200 / 1000", w / 2, h * 0.74, 13 * u);
      } else if (G.mode === "over") {
        text("GAME OVER", w / 2, h * 0.42, 44 * u);
        text(`SCORE  ${G.score}`, w / 2, h * 0.51, 20 * u);
        if (G.score >= G.high && G.score > 0) text("NEW HIGH SCORE!", w / 2, h * 0.57, 16 * u);
        if (Math.floor(G.time * 1.6) % 2 === 0) text("TAP OR PRESS ENTER TO PLAY AGAIN", w / 2, h * 0.66, 16 * u);
      } else if (G.paused) {
        text("PAUSED", w / 2, h * 0.5, 36 * u);
        text("TAP OR PRESS P TO RESUME", w / 2, h * 0.58, 14 * u);
      }
    }

    // ---------- loop ----------
    let raf = 0;
    let last = performance.now();
    let alive = true;
    function frame(now: number) {
      if (!alive) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      update(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    // ---------- input ----------
    function press(e: KeyboardEvent, down: boolean) {
      const inp = inputRef.current;
      switch (e.code) {
        case "ArrowLeft": case "KeyA": inp.left = down; break;
        case "ArrowRight": case "KeyD": inp.right = down; break;
        case "ArrowUp": case "KeyW": inp.thrust = down; break;
        case "Space": inp.fire = down; break;
        case "ShiftLeft": case "ShiftRight": case "KeyH": inp.hyper = down; break;
        default: return;
      }
      e.preventDefault();
    }

    function onKeyDown(e: KeyboardEvent) {
      initAudio();
      if (e.code === "Enter") {
        if (G.mode === "title" || (G.mode === "over" && G.restartLock <= 0)) startGame();
        return;
      }
      if (e.code === "KeyP" && G.mode === "playing") {
        G.paused = !G.paused;
        return;
      }
      if (e.code === "KeyM") {
        setMuted((m) => !m);
        return;
      }
      if (G.paused && G.mode === "playing") { G.paused = false; return; }
      press(e, true);
    }
    function onKeyUp(e: KeyboardEvent) { press(e, false); }

    function onCanvasDown(e: PointerEvent) {
      e.preventDefault();
      initAudio();
      if (G.mode === "title" || (G.mode === "over" && G.restartLock <= 0)) startGame();
      else if (G.paused) G.paused = false;
    }

    function onVis() {
      if (document.hidden && G.mode === "playing") G.paused = true;
    }

    // pause hook for the on-screen button
    (canvas as unknown as { __togglePause?: () => void }).__togglePause = () => {
      if (G.mode === "playing") G.paused = !G.paused;
    };
    (canvas as unknown as { __initAudio?: () => void }).__initAudio = initAudio;

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVis);
    canvas.addEventListener("pointerdown", onCanvasDown);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("pointerdown", onCanvasDown);
      if (A.ctx) A.ctx.close();
    };
  }, []);

  function setInput(key: keyof InputState, down: boolean) {
    inputRef.current[key] = down;
  }

  function TouchBtn({ label, k, style, big }: { label: string; k: keyof InputState; style?: React.CSSProperties; big?: boolean }) {
    return (
      <button
        aria-label={label}
        onPointerDown={(e) => {
          e.preventDefault();
          setInput(k, true);
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer may already be gone */ }
          const c = canvasRef.current as unknown as { __initAudio?: () => void } | null;
          c?.__initAudio?.();
        }}
        onPointerUp={(e) => { e.preventDefault(); setInput(k, false); }}
        onPointerCancel={() => setInput(k, false)}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          width: big ? 84 : 64,
          height: big ? 84 : 64,
          borderRadius: "50%",
          border: "2px solid rgba(255,255,255,0.55)",
          background: "rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.85)",
          fontSize: big ? 15 : 13,
          fontFamily: "'Lucida Console', Monaco, monospace",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          ...style,
        }}
      >
        {label}
      </button>
    );
  }

  const smallBtn: React.CSSProperties = {
    border: "1px solid rgba(255,255,255,0.45)",
    background: "rgba(255,255,255,0.08)",
    color: "rgba(255,255,255,0.85)",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 13,
    fontFamily: "'Lucida Console', Monaco, monospace",
    touchAction: "manipulation",
    userSelect: "none",
    WebkitUserSelect: "none",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        overflow: "hidden",
        touchAction: "none",
        WebkitTouchCallout: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      <canvas ref={canvasRef} style={{ display: "block", touchAction: "none" }} />

      {/* top-right: mute + pause */}
      <div style={{ position: "absolute", top: "max(10px, env(safe-area-inset-top))", right: "max(10px, env(safe-area-inset-right))", display: "flex", gap: 8 }}>
        <button
          style={smallBtn}
          aria-label={muted ? "Unmute" : "Mute"}
          onClick={() => setMuted((m) => !m)}
          onContextMenu={(e) => e.preventDefault()}
        >
          {muted ? "SOUND OFF" : "SOUND ON"}
        </button>
        <button
          style={smallBtn}
          aria-label="Pause"
          onClick={() => {
            const c = canvasRef.current as unknown as { __togglePause?: () => void } | null;
            c?.__togglePause?.();
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          ⏸
        </button>
      </div>

      {/* bottom-left: rotate */}
      <div
        style={{
          position: "absolute",
          left: "max(14px, env(safe-area-inset-left))",
          bottom: "max(18px, env(safe-area-inset-bottom))",
          display: "flex",
          gap: 14,
        }}
      >
        <TouchBtn label="◀" k="left" big />
        <TouchBtn label="▶" k="right" big />
      </div>

      {/* bottom-right: hyper on top, thrust + fire below */}
      <div
        style={{
          position: "absolute",
          right: "max(14px, env(safe-area-inset-right))",
          bottom: "max(18px, env(safe-area-inset-bottom))",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 12,
        }}
      >
        <TouchBtn label="HYPER" k="hyper" style={{ width: 58, height: 58, marginRight: 90 }} />
        <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
          <TouchBtn label="THRUST" k="thrust" style={{ marginBottom: 14 }} />
          <TouchBtn label="FIRE" k="fire" big />
        </div>
      </div>
    </div>
  );
}
