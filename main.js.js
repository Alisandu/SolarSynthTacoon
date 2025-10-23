/* ============================================================
   Solar Synth Tycoon — AI Demo (no libs, browser-ready)
   ============================================================ */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const tiltSlider = document.getElementById('tilt');
const elecSlider = document.getElementById('electrolyte');
const tiltVal = document.getElementById('tiltVal');
const elecVal = document.getElementById('electrolyteVal');

const timeLabel = document.getElementById('timeLabel');
const luxLabel = document.getElementById('luxLabel');
const h2RateLabel = document.getElementById('h2RateLabel');
const h2TotalLabel = document.getElementById('h2TotalLabel');

const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');

const aiToggle = document.getElementById('aiToggle');
const epsilonRange = document.getElementById('epsilon');
const epsilonVal = document.getElementById('epsilonVal');
const aiPeriodInput = document.getElementById('aiPeriod');

const bestTiltLabel = document.getElementById('bestTilt');
const bestElecLabel = document.getElementById('bestElec');
const bestRateLabel = document.getElementById('bestRate');

/* ------------------ Game State ------------------ */
let running = false;
let gameTime = 0;            // seconds elapsed
let lastTs = 0;              // for delta timing
let totalH2mL = 0;           // accumulated hydrogen (mL)

const state = {
  tiltDeg: Number(tiltSlider.value),         // 0..60
  electrolytePct: Number(elecSlider.value),  // 0..2
  sunPhase: 0,         // internal phase for sun animation
  sunLux: 0            // current lux (simulated)
};

/* AI ε-greedy memory of (tilt, elec) -> avg reward (H2 rate) */
const ai = {
  enabled: false,
  epsilon: Number(epsilonRange.value),
  best: { tilt: null, elec: null, rate: -Infinity },
  memory: new Map(),  // key: "t|e" -> {sum, count, avg}
  lastAiEval: 0,      // last time AI applied (sec)
  periodSec: Number(aiPeriodInput.value)
};

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

/* ------------------ Environment / Simulation ------------------ */
/** Simulated sun intensity (lux). Varies during the day + noise. */
function computeSunLux(tSec){
  // base day length ~ 6 minutes (speed up), phase cycles 0..2π
  const day = 360; // seconds for full cycle
  const phase = (tSec % day) / day * Math.PI * 2;
  // sin gives 0..1 day curve; clamp for night
  let base = Math.max(0, Math.sin(phase));
  // add drifting clouds via low-freq noise
  const clouds = 0.15 * Math.sin(phase * 2.4 + 1.7) + 0.08 * Math.sin(phase * 4.1 + 0.3);
  base = clamp(base + clouds, 0, 1);
  // scale to lux-ish number
  return Math.round(10000 + base * 70000); // 10k..80k lux
}

/** Tilt efficiency — maximal when panel tilt matches "sun altitude". */
function tiltEfficiency(tiltDeg, tSec){
  // Pretend the sun altitude swings 0..60 degrees during the "day"
  const day = 360;
  const phase = (tSec % day) / day;
  const sunAlt = Math.max(0, Math.sin(phase * Math.PI) * 60); // 0..60
  // efficiency by angular difference
  const diff = Math.abs(tiltDeg - sunAlt);
  const eff = Math.cos((diff * Math.PI) / 180); // cos from 1 to ~0
  return clamp(eff, 0, 1);
}

/** Electrolyte effect: broad peak around ~0.8% */
function electrolyteEfficiency(pct){
  // Smooth peak using Gaussian-like curve
  const mu = 0.85;
  const sigma = 0.45; // wider = broader peak
  const x = pct;
  const eff = Math.exp(-0.5 * Math.pow((x - mu)/sigma, 2));
  // scale so edges aren't zero
  return clamp(0.2 + 0.8 * eff, 0, 1);
}

/** Convert lux & efficiencies to hydrogen rate (mL/min) */
function computeH2Rate(lux, tiltEff, elecEff){
  // Simple model: rate ∝ lux × tiltEff × elecEff × constant
  // tune constant so numbers are readable (e.g., 0..30 mL/min)
  const k = 0.00035;
  // slight random jitter (measurement noise)
  const noise = (Math.random() - 0.5) * 0.5;
  const rate = lux * tiltEff * elecEff * k + noise;
  return Math.max(0, rate);
}

/* ------------------ AI: ε-greedy over discrete bins ------------------ */
function discretize(tilt, elec){
  // bins: tilt step 5°, elec step 0.1%
  const t = Math.round(tilt / 5) * 5;
  const e = Math.round(elec * 10) / 10;
  return {t, e};
}
function memKey(t, e){ return `${t}|${e}`; }

function aiRecord(tilt, elec, reward){
  const {t, e} = discretize(tilt, elec);
  const key = memKey(t, e);
  const rec = ai.memory.get(key) || {sum:0, count:0, avg:0};
  rec.sum += reward;
  rec.count += 1;
  rec.avg = rec.sum / rec.count;
  ai.memory.set(key, rec);

  if (reward > ai.best.rate){
    ai.best = { tilt: t, elec: e, rate: reward };
    updateBestLabels();
  }
}

function aiSuggest(){
  // with prob ε, explore random; else exploit best avg from memory
  if (Math.random() < ai.epsilon || ai.memory.size === 0){
    const randTilt = Math.round((Math.random() * 60)/5)*5;
    const randElec = Math.round((Math.random() * 2)*10)/10;
    return { tilt: randTilt, elec: randElec, reason: 'explore' };
  }
  // exploit: pick memory entry with highest avg
  let bestKey = null, bestAvg = -Infinity;
  for (const [key, rec] of ai.memory.entries()){
    if (rec.avg > bestAvg){ bestAvg = rec.avg; bestKey = key; }
  }
  const [tStr, eStr] = bestKey.split('|');
  return { tilt: Number(tStr), elec: Number(eStr), reason: 'exploit' };
}

function updateBestLabels(){
  bestTiltLabel.textContent = (ai.best.tilt ?? '—');
  bestElecLabel.textContent = (ai.best.elec ?? '—');
  bestRateLabel.textContent = ai.best.rate === -Infinity ? '—' : ai.best.rate.toFixed(2);
}

/* ------------------ UI bindings ------------------ */
function syncLabels(){
  tiltVal.textContent = `${state.tiltDeg}°`;
  elecVal.textContent = `${state.electrolytePct}%`;
  epsilonVal.textContent = Number(epsilonRange.value).toFixed(2);
}
tiltSlider.addEventListener('input', () => {
  state.tiltDeg = Number(tiltSlider.value);
  syncLabels();
});
elecSlider.addEventListener('input', () => {
  state.electrolytePct = Number(elecSlider.value);
  syncLabels();
});
epsilonRange.addEventListener('input', () => {
  ai.epsilon = Number(epsilonRange.value);
  syncLabels();
});
aiToggle.addEventListener('change', () => ai.enabled = aiToggle.checked);
aiPeriodInput.addEventListener('change', () => {
  ai.periodSec = clamp(Number(aiPeriodInput.value)||5, 2, 30);
  aiPeriodInput.value = ai.periodSec;
});
startBtn.addEventListener('click', () => { running = true; });
pauseBtn.addEventListener('click', () => { running = false; });
resetBtn.addEventListener('click', resetGame);

function resetGame(){
  running = false;
  gameTime = 0; lastTs = 0; totalH2mL = 0;
  state.tiltDeg = Number(tiltSlider.value);
  state.electrolytePct = Number(elecSlider.value);
  ai.memory.clear();
  ai.best = { tilt: null, elec: null, rate: -Infinity };
  ai.lastAiEval = 0;
  updateBestLabels();
  syncLabels();
  draw(0);
}

/* ------------------ Draw ------------------ */
function drawSun(lux){
  // map lux 10k..80k to radius/color/intensity
  const t = (lux - 10000) / (80000 - 10000);
  const x = 80 + t * (canvas.width - 160);
  const y = 120 - Math.sin(t * Math.PI) * 60;

  const radius = 20 + 20 * t;
  const grd = ctx.createRadialGradient(x, y, radius*0.2, x, y, radius*1.6);
  grd.addColorStop(0, `rgba(255, 220, 120, 1)`);
  grd.addColorStop(1, `rgba(255, 220, 120, 0)`);
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(x, y, radius*1.6, 0, Math.PI*2);
  ctx.fill();

  ctx.fillStyle = '#FFD166';
  ctx.beginPath();
  ctx.arc(x, y, radius*0.7, 0, Math.PI*2);
  ctx.fill();
}

function drawPanel(tiltDeg){
  const cx = canvas.width/2, cy = canvas.height - 60;
  const w = 180, h = 12;
  const angle = -tiltDeg * Math.PI/180;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  // mast
  ctx.fillStyle = '#3b4252';
  ctx.fillRect(-6, -6, 12, 60);
  // panel
  ctx.fillStyle = '#1f6feb';
  ctx.fillRect(-w/2, -h/2-40, w, h);
  // border
  ctx.strokeStyle = '#e5e9f0';
  ctx.lineWidth = 2;
  ctx.strokeRect(-w/2, -h/2-40, w, h);
  ctx.restore();

  // ground
  ctx.fillStyle = '#264653';
  ctx.fillRect(0, canvas.height-40, canvas.width, 40);
}

function drawReadouts(lux, tiltEff, elecEff, rate){
  ctx.fillStyle = '#e6edf3';
  ctx.font = '14px system-ui';
  ctx.fillText(`Lux: ${lux}`, 16, 24);
  ctx.fillText(`Tilt eff: ${(tiltEff*100).toFixed(0)}%`, 16, 44);
  ctx.fillText(`Electrolyte eff: ${(elecEff*100).toFixed(0)}%`, 16, 64);
  ctx.fillText(`H₂ rate: ${rate.toFixed(2)} mL/min`, 16, 84);
}

function draw(ts){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  drawSun(state.sunLux);
  drawPanel(state.tiltDeg);
  // (other UI is in DOM; canvas shows the scene only)
}

/* ------------------ Main Loop ------------------ */
function step(ts){
  if (!lastTs) lastTs = ts;
  const dt = (ts - lastTs) / 1000; // seconds
  lastTs = ts;

  if (running){
    gameTime += dt;

    // Update sun & physics once per frame
    state.sunLux = computeSunLux(gameTime);
    const tiltEff = tiltEfficiency(state.tiltDeg, gameTime);
    const elecEff = electrolyteEfficiency(state.electrolytePct);
    const h2Rate = computeH2Rate(state.sunLux, tiltEff, elecEff); // mL/min

    // accumulate hydrogen by dt
    totalH2mL += h2Rate * (dt/60);

    // Every second, let AI observe & maybe act
    if (Math.floor(gameTime) !== Math.floor(gameTime - dt)){
      // record current outcome into AI memory
      aiRecord(state.tiltDeg, state.electrolytePct, h2Rate);

      // AI decision every ai.periodSec seconds
      if (ai.enabled && gameTime - ai.lastAiEval >= ai.periodSec){
        const suggestion = aiSuggest();
        state.tiltDeg = suggestion.tilt;
        state.electrolytePct = suggestion.elec;
        tiltSlider.value = state.tiltDeg;
        elecSlider.value = state.electrolytePct.toFixed(1);
        ai.lastAiEval = gameTime;
      }
    }

    // Update DOM labels
    const m = Math.floor(gameTime/60), s = Math.floor(gameTime%60);
    timeLabel.textContent = `${m}:${s.toString().padStart(2,'0')}`;
    luxLabel.textContent = state.sunLux.toLocaleString();
    h2RateLabel.textContent = (computeH2Rate(state.sunLux,
                            tiltEfficiency(state.tiltDeg, gameTime),
                            electrolyteEfficiency(state.electrolytePct))).toFixed(2);
    h2TotalLabel.textContent = totalH2mL.toFixed(1);

    syncLabels();
  }

  draw(ts);
  requestAnimationFrame(step);
}

/* ------------------ Init ------------------ */
function init(){
  syncLabels();
  updateBestLabels();
  state.sunLux = computeSunLux(0);
  draw(0);
  requestAnimationFrame(step);
}
init();