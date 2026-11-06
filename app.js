'use strict';
const el = id => document.getElementById(id);
const preset = el('preset'), ref = el('ref'), mic = el('mic'), strings = el('strings');
const strobe = el('strobe');
let strobeSpeed = 0, strobePhase = 0;
const tunings = {standard:[40,45,50,55,59,64],drop:[38,45,50,55,59,64],half:[39,44,49,54,58,63]};
const names = ['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
const noteName = midi => names[(midi % 12 + 12) % 12] + (Math.floor(midi / 12) - 1);
let target = null, session = null, last = null, lastSignal = 0, wake = null;
try {
  const stored = JSON.parse(localStorage.getItem('guitar-tuner') || '{}');
  if ([...preset.options].some(option => option.value === stored.preset)) preset.value = stored.preset;
  if ([...ref.options].some(option => option.value === stored.ref)) ref.value = stored.ref;
} catch {}
function save() {
  try { localStorage.setItem('guitar-tuner', JSON.stringify({preset:preset.value,ref:ref.value})); } catch {}
}
function reset(message) {
  el('note').textContent = '—';
  el('freq').textContent = target === null ? '— Hz' : 'Objetivo ' + noteName(target);
  el('needle').hidden = true;
  strobeSpeed = 0;
  strobe.classList.remove('active');
  el('readout').classList.remove('tuned', 'held');
  el('status').textContent = message;
  strings.querySelector('[data-hit]')?.removeAttribute('data-hit');
  last = null;
}
function drawStrings() {
  strings.replaceChildren();
  if (!tunings[preset.value]) return;
  for (const midi of [null,...tunings[preset.value]]) {
    const button = document.createElement('button');
    button.textContent = midi === null ? 'Auto' : noteName(midi);
    button.dataset.note = midi;
    button.setAttribute('aria-pressed', midi === target);
    button.onclick = () => {
      target = midi;
      drawStrings();
      reset(session?.analyser ? 'Toca una cuerda' : 'Activa el micrófono para empezar');
    };
    strings.append(button);
  }
}
preset.onchange = () => {
  target = null;
  drawStrings();
  ref.onchange();
};
ref.onchange = () => { save(); reset(session?.analyser ? 'Toca una cuerda' : 'Activa el micrófono para empezar'); };
drawStrings();

function show(hz) {
  const midi = 69 + 12 * Math.log2(hz / Number(ref.value));
  const detected = Math.round(midi);
  const goal = target ?? detected;
  const offset = 100 * (midi - goal);
  const cents = Math.round(offset);
  const tuned = Math.abs(offset) <= 1;
  strobeSpeed = tuned ? 0 : Math.sign(offset) * Math.min(210, 14 * Math.sqrt(Math.abs(offset)));
  strobe.classList.add('active');
  el('note').textContent = noteName(detected);
  el('freq').textContent = hz.toFixed(1) + ' Hz' + (target === null ? '' : ' · objetivo ' + noteName(target));
  el('needle').hidden = false;
  el('needle').style.left = 50 + Math.max(-50, Math.min(50,cents)) + '%';
  el('readout').classList.remove('held');
  el('readout').classList.toggle('tuned', tuned);
  el('status').textContent = tuned ? 'Afinada · ' + cents + ' ¢' : (cents < 0 ? 'Baja · ' : 'Alta · +') + cents + ' ¢';
  const active = strings.querySelector('[data-hit]');
  if (active?.dataset.note !== String(detected)) {
    active?.removeAttribute('data-hit');
    strings.querySelector('[data-note="' + detected + '"]')?.setAttribute('data-hit','');
  }
}
async function keepAwake(current) {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (session === current) wake = lock;
    else await lock?.release();
  } catch {}
}
function stop(message = 'Micrófono apagado') {
  const current = session;
  session = null;
  if (current) {
    cancelAnimationFrame(current.frame);
    current.stream?.getTracks().forEach(track => track.stop());
    current.context?.close().catch(() => {});
  }
  wake?.release().catch(() => {});
  wake = null;
  mic.disabled = false;
  mic.textContent = 'Activar micrófono';
  el('input').value = 0;
  reset(message);
}
mic.onclick = async () => {
  if (session) { stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { reset('Abre el afinador en Safari mediante HTTPS'); return; }
  const current = {};
  session = current;
  mic.disabled = true;
  reset('Solicitando acceso al micrófono…');
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    current.context = new Audio();
    const resume = current.context.resume().catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1}});
    if (session !== current) { stream.getTracks().forEach(track => track.stop()); return; }
    current.stream = stream;
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
      if (session === current) stop('Se desconectó el micrófono');
    }));
    const analyser = current.context.createAnalyser();
    analyser.fftSize = 8192;
    const input = current.context.createMediaStreamSource(stream);
    const silent = current.context.createGain();
    silent.gain.value = 0;
    const filter = current.context.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 28;
    filter.Q.value = 0.707;
    input.connect(filter);
    filter.connect(analyser);
    analyser.connect(silent);
    silent.connect(current.context.destination);
    await resume;
    if (session !== current) return;
    if (current.context.state !== 'running') await current.context.resume();
    if (session !== current) return;
    current.analyser = analyser;
    const inputRate = current.context.sampleRate;
    const stride = Math.max(1, Math.round(inputRate / 24000));
    const rate = inputRate / stride;
    const capture = new Float32Array(analyser.fftSize);
    const samples = new Float32Array(Math.floor(capture.length / stride));
    const difference = new Float32Array(Math.ceil(rate / lowestPitch) + 2);
    let tick = -Infinity, previousFrame = null;
    let lastHint = '';
    let pendingWeak = null;
    lastSignal = 0;
    mic.disabled = false;
    mic.textContent = 'Apagar micrófono';
    reset('Toca una cuerda');
    keepAwake(current);
    function frame(now) {
      if (session !== current) return;
      if (now - tick >= 75) {
        tick = now;
        analyser.getFloatTimeDomainData(capture);
        for (let i = 0; i < samples.length; i++) {
          let sum = 0;
          for (let j = 0; j < stride; j++) sum += capture[i * stride + j];
          samples[i] = sum / stride;
        }
        const level = signalLevel(samples);
        el('input').value = Math.max(0, Math.min(1, (20 * Math.log10(level) + 84) / 54));
        const state = readingState(now - lastSignal);
        const hz = estimate(samples, rate, difference, level);
        const matchesLast = hz !== null && last !== null && Math.abs(1200 * Math.log2(hz / last)) <= 60;
        const confirmsWeak = hz !== null && pendingWeak !== null && Math.abs(1200 * Math.log2(hz / pendingWeak)) <= 35;
        pendingWeak = level < attackLevel ? hz : null;
        if (hz !== null && (level >= attackLevel || matchesLast || confirmsWeak)) {
          last = last && Math.abs(Math.log2(hz / last)) < 0.045 ? 0.65 * last + 0.35 * hz : hz;
          lastSignal = now;
          show(last);
          lastHint = '';
        } else if (last !== null && state === 'held') {
          strobeSpeed = 0;
          el('readout').classList.remove('tuned');
          el('readout').classList.add('held');
          if (lastHint !== 'held') el('status').textContent = 'Última nota · esperando señal';
          lastHint = 'held';
        } else if (last === null) {
          const hint = level < attackLevel ? 'Toca una cuerda' : 'Hay señal · toca una sola cuerda';
          if (hint !== lastHint) {
            reset(hint);
            lastHint = hint;
          }
        }
      }
      if (strobeSpeed && previousFrame !== null) {
        strobePhase = (strobePhase + strobeSpeed * Math.min(50, now - previousFrame) / 1000) % 24;
        strobe.style.setProperty('--phase', strobePhase + 'px');
      }
      previousFrame = now;
      current.frame = requestAnimationFrame(frame);
    }
    current.frame = requestAnimationFrame(frame);
  } catch (error) {
    if (session === current) stop(error.name === 'NotAllowedError' ? 'Permite el micrófono en los ajustes de Safari' : 'No se pudo iniciar el micrófono');
  }
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && session?.analyser) stop();
});
window.addEventListener('pagehide', () => { if (session) stop(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
