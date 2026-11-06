const lowestPitch = 40;
const highestPitch = 1800;
const attackLevel = 0.00020;
const sustainLevel = 0.00004;

function readingState(age) {
  if (age <= 375) return 'live';
  return 'held';
}

function signalLevel(samples) {
  let sum = 0;
  let squares = 0;
  for (const sample of samples) {
    sum += sample;
    squares += sample * sample;
  }
  return Math.sqrt(Math.max(0, squares / samples.length - (sum / samples.length) ** 2));
}
function estimate(samples, rate, difference, level = signalLevel(samples)) {
  if (level < sustainLevel) return null;
  return measurePeriod(samples, rate, difference, 0.085, 0.23)
    ?? measurePeriod(samples, rate, difference, 0.045, 0.16);
}

function measurePeriod(samples, rate, difference, seconds, maxScore) {
  const maxLag = Math.min(Math.ceil(rate / lowestPitch) + 1, difference.length - 1);
  const minLag = Math.floor(rate / highestPitch);
  const window = Math.min(Math.round(rate * seconds), samples.length - maxLag);
  const start = samples.length - window - maxLag;
  let energy = 0;
  for (let i = start; i < start + window; i++) energy += samples[i] * samples[i];
  let shiftedEnergy = energy;
  let running = 0;
  difference[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    shiftedEnergy += samples[start + window + lag - 1] ** 2 - samples[start + lag - 1] ** 2;
    let product = 0;
    for (let i = start; i < start + window; i++) {
      product += samples[i] * samples[i + lag];
    }
    // Normalize each pair so a decaying string can still match its previous cycle.
    const scale = Math.sqrt(Math.max(0, energy * shiftedEnergy));
    const sum = scale > 0 ? Math.max(0, 1 - product / scale) : 1;
    running += sum;
    difference[lag] = running ? sum * lag / running : 1;
  }
  let candidate = -1;
  let bestScore = maxScore;
  for (let lag = minLag; lag < maxLag; lag++) {
    const score = difference[lag];
    if (score >= bestScore || score > difference[lag - 1] || score >= difference[lag + 1]) continue;
    candidate = lag;
    bestScore = score;
    if (score < 0.14) break;
  }
  if (candidate >= 0) {
    let lag = candidate;
    // A strong second harmonic can hide the actual period of a low string.
    const harmonicLag = lag * 2;
    if (rate / lag < 400 && harmonicLag + 1 < maxLag) {
      const radius = Math.max(2, Math.round(harmonicLag * 0.03));
      let fundamentalLag = harmonicLag;
      for (let i = harmonicLag - radius; i <= Math.min(harmonicLag + radius, maxLag - 1); i++) {
        if (difference[i] < difference[fundamentalLag]) fundamentalLag = i;
      }
      const score = difference[lag];
      if (difference[fundamentalLag] < score * 0.68 && score - difference[fundamentalLag] > 0.01) {
        lag = fundamentalLag;
      }
    }
    const left = difference[lag - 1], middle = difference[lag], right = difference[lag + 1];
    const curvature = left - 2 * middle + right;
    const refined = lag + (curvature ? 0.5 * (left - right) / curvature : 0);
    const hz = rate / refined;
    if (hz >= lowestPitch - 0.5 && hz <= highestPitch + 5) return hz;
  }
  return null;
}
