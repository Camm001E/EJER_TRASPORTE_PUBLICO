const STRIDE = 8;
const HEADER_INTS = 16;
const HEADER_BYTES = HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const ROUTE_VERTICES = 1820;
const GRID_SIZE = 0.025;
const WINDOW_SIZE = 5;
const HISTORY_SAMPLES = 241;
const HISTORY_STEP_MS = 30_000;
const TRAVEL_SEGMENTS = 12;
const HISTOGRAM_BINS = 48;

let busCount = 310;
let routeCount = 22;
let buses = [];
let routes = [];
let spatialIndex = new Map();
let sequenceWindows = [];
let sharedBuffer = null;
let header = null;
let sharedViews = [];
let paused = false;
let historyMinutes = 0;
let cursor = 0;
let messageCounter = 0;
let ignoredOutOfOrder = 0;
let lastMetricsAt = performance.now();
let lastAlertAt = 0;
let lastFallbackFrame = 0;
let latestAlerts = [];
let seed = 0x5f3759df;
let historyBuffer = null;
let historyCursor = HISTORY_SAMPLES - 1;
let lastHistorySampleAt = performance.now();
let travelHistograms = [];

function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}

function gaussian() {
  const u = Math.max(random(), 1e-7);
  const v = Math.max(random(), 1e-7);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function routePoint(route, progress) {
  const t = ((progress % 1) + 1) % 1;
  const band = route % 6;
  const side = route % 2 === 0 ? -1 : 1;
  const lane = ((route % 4) - 1.5) * 0.0065;
  const entryY = 0.5 + lane;
  const originY = 0.1 + (band / 5) * 0.8;
  const destinationY = 0.9 - (band / 5) * 0.8;
  const wave = Math.sin((route + 2) * 0.74) * 0.018;

  if (t < 0.24) {
    const p = t / 0.24;
    const eased = p * p * (3 - 2 * p);
    return {
      x: 0.06 + 0.22 * eased,
      y: originY + (entryY - originY) * eased + Math.sin(p * Math.PI) * wave
    };
  }
  if (t < 0.76) {
    const p = (t - 0.24) / 0.52;
    const parallelShift = route % 8 < 4 ? -0.012 : 0.012;
    return {
      x: 0.28 + 0.44 * p,
      y: entryY + parallelShift + Math.sin(p * Math.PI * 2 + route * 0.35) * 0.008
    };
  }
  const p = (t - 0.76) / 0.24;
  const eased = p * p * (3 - 2 * p);
  return {
    x: 0.72 + 0.22 * eased,
    y: entryY + (destinationY - entryY) * eased - Math.sin(p * Math.PI) * wave * side
  };
}

function createCartography() {
  routes = Array.from({ length: routeCount }, (_, route) => {
    const points = new Float32Array(ROUTE_VERTICES * 2);
    for (let index = 0; index < ROUTE_VERTICES; index += 1) {
      const point = routePoint(route, index / (ROUTE_VERTICES - 1));
      points[index * 2] = point.x;
      points[index * 2 + 1] = point.y;
    }
    return points;
  });
}

function cellKey(x, y) {
  return `${Math.floor(x / GRID_SIZE)}:${Math.floor(y / GRID_SIZE)}`;
}

function buildSpatialIndex() {
  spatialIndex = new Map();
  routes.forEach((points, route) => {
    for (let segment = 0; segment < ROUTE_VERTICES - 1; segment += 1) {
      const x = (points[segment * 2] + points[(segment + 1) * 2]) / 2;
      const y = (points[segment * 2 + 1] + points[(segment + 1) * 2 + 1]) / 2;
      const key = cellKey(x, y);
      const packed = route * 4096 + segment;
      const bucket = spatialIndex.get(key);
      if (bucket) bucket.push(packed);
      else spatialIndex.set(key, [packed]);
    }
  });
}

function projectToSegment(px, py, route, segment) {
  const points = routes[route];
  const ax = points[segment * 2];
  const ay = points[segment * 2 + 1];
  const bx = points[(segment + 1) * 2];
  const by = points[(segment + 1) * 2 + 1];
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy || 1e-12;
  const along = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + along * dx;
  const y = ay + along * dy;
  const ex = px - x;
  const ey = py - y;
  return {
    progress: (segment + along) / (ROUTE_VERTICES - 1),
    x,
    y,
    distanceSquared: ex * ex + ey * ey
  };
}

function findCandidates(x, y, route) {
  const cx = Math.floor(x / GRID_SIZE);
  const cy = Math.floor(y / GRID_SIZE);
  const candidates = [];
  for (let radius = 1; radius <= 2 && candidates.length < 8; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        const bucket = spatialIndex.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const packed of bucket) {
          const candidateRoute = Math.floor(packed / 4096);
          if (candidateRoute !== route) continue;
          const segment = packed % 4096;
          candidates.push(projectToSegment(x, y, route, segment));
        }
      }
    }
  }
  candidates.sort((a, b) => a.distanceSquared - b.distanceSquared);
  return candidates.slice(0, 10);
}

function sequenceMatch(bus, candidates) {
  if (!candidates.length) return { progress: bus.matchedProgress, ...routePoint(bus.route, bus.matchedProgress) };
  const window = sequenceWindows[bus.id];
  window.push(candidates);
  if (window.length > WINDOW_SIZE) window.shift();

  let costs = window[0].map((candidate) => candidate.distanceSquared * 900_000);
  let paths = window[0].map((_, index) => [index]);

  for (let step = 1; step < window.length; step += 1) {
    const nextCosts = new Array(window[step].length).fill(Infinity);
    const nextPaths = new Array(window[step].length);
    for (let current = 0; current < window[step].length; current += 1) {
      const candidate = window[step][current];
      const emission = candidate.distanceSquared * 900_000;
      for (let previous = 0; previous < window[step - 1].length; previous += 1) {
        const prior = window[step - 1][previous];
        const movement = candidate.progress - prior.progress;
        const reversePenalty = movement < -0.0015 ? 28 + Math.abs(movement) * 900 : 0;
        const jumpPenalty = Math.abs(movement - bus.expectedStep) * 1450;
        const score = costs[previous] + emission + reversePenalty + jumpPenalty;
        if (score < nextCosts[current]) {
          nextCosts[current] = score;
          nextPaths[current] = [...paths[previous], current];
        }
      }
    }
    costs = nextCosts;
    paths = nextPaths;
  }

  let best = 0;
  for (let i = 1; i < costs.length; i += 1) if (costs[i] < costs[best]) best = i;
  return window[window.length - 1][best];
}

function createFleet() {
  const routeSlots = new Array(routeCount).fill(0);
  const routeTotals = new Array(routeCount).fill(0);
  for (let id = 0; id < busCount; id += 1) routeTotals[id % routeCount] += 1;

  buses = Array.from({ length: busCount }, (_, id) => {
    const route = id % routeCount;
    const slot = routeSlots[route]++;
    const progress = (slot + 0.35 + random() * 0.18) / routeTotals[route];
    const speed = 17 + random() * 15;
    const outOfService = id % 8 === 0;
    return {
      id,
      route,
      progress,
      matchedProgress: progress,
      speed,
      speedNormalized: speed / 18 / 3600,
      expectedStep: speed / 18 / 360,
      status: outOfService ? 2 : 0,
      risk: 0,
      lastTimestamp: Date.now() + Math.round((random() - 0.5) * 180_000),
      serverUpdatedAt: performance.now(),
      clockOffset: Math.round((random() - 0.5) * 180_000),
      silenceUntil: id % 61 === 0 ? performance.now() + 48_000 + random() * 70_000 : 0,
      travelSegment: Math.min(TRAVEL_SEGMENTS - 1, Math.floor(progress * TRAVEL_SEGMENTS)),
      segmentEnteredAt: performance.now() - random() * 120_000,
      x: 0,
      y: 0
    };
  });
  sequenceWindows = Array.from({ length: busCount }, () => []);
  travelHistograms = Array.from({ length: routeCount * TRAVEL_SEGMENTS }, () => new Uint32Array(HISTOGRAM_BINS));
  historyBuffer = new Float32Array(busCount * HISTORY_SAMPLES);
  for (const bus of buses) {
    for (let sample = 0; sample < HISTORY_SAMPLES; sample += 1) {
      const ageSeconds = (HISTORY_SAMPLES - 1 - sample) * 30;
      historyBuffer[bus.id * HISTORY_SAMPLES + sample] = ((bus.progress - ageSeconds * bus.speedNormalized) % 1 + 1) % 1;
    }
  }
}

function recordTraversal(bus, nextSegment, now) {
  if (nextSegment === bus.travelSegment) return;
  const elapsedSeconds = (now - bus.segmentEnteredAt) / 1000;
  if (elapsedSeconds > 2 && elapsedSeconds < 1_800) {
    const histogram = travelHistograms[bus.route * TRAVEL_SEGMENTS + bus.travelSegment];
    const bin = Math.min(HISTOGRAM_BINS - 1, Math.floor(elapsedSeconds / 15));
    histogram[bin] += 1;
  }
  bus.travelSegment = nextSegment;
  bus.segmentEnteredAt = now;
}

function histogramPercentile(histogram, percentile) {
  let total = 0;
  for (const count of histogram) total += count;
  if (!total) return 0;
  const target = total * percentile;
  let accumulated = 0;
  for (let bin = 0; bin < histogram.length; bin += 1) {
    accumulated += histogram[bin];
    if (accumulated >= target) return bin * 15 + 7.5;
  }
  return (histogram.length - 1) * 15;
}

function sampleHistory(now) {
  if (now - lastHistorySampleAt < HISTORY_STEP_MS) return;
  historyCursor = (historyCursor + 1) % HISTORY_SAMPLES;
  for (const bus of buses) {
    historyBuffer[bus.id * HISTORY_SAMPLES + historyCursor] = bus.progress;
  }
  lastHistorySampleAt = now;
}

function runAcceptanceTest() {
  const observations = [];
  const bounceIndices = new Set([12, 25, 39, 54, 69, 84, 101, 117, 132]);
  for (let i = 0; i < 145; i += 1) {
    const x = 0.2 + (i / 144) * 0.6;
    const y = bounceIndices.has(i) ? 0.511 : 0.49 + Math.sin(i * 0.8) * 0.0008;
    observations.push({ x, y });
  }

  const nearestStates = observations.map((point) => Math.abs(point.y - 0.49) <= Math.abs(point.y - 0.51) ? 0 : 1);
  let nearestSwitches = 0;
  for (let i = 1; i < nearestStates.length; i += 1) if (nearestStates[i] !== nearestStates[i - 1]) nearestSwitches += 1;

  let costs = [0, 0];
  const states = [];
  for (const point of observations) {
    const emission = [Math.abs(point.y - 0.49) * 300, Math.abs(point.y - 0.51) * 300];
    const next = [0, 0];
    const predecessor = [0, 0];
    for (let lane = 0; lane < 2; lane += 1) {
      const stay = costs[lane];
      const change = costs[1 - lane] + 9;
      if (stay <= change) {
        next[lane] = stay + emission[lane];
        predecessor[lane] = lane;
      } else {
        next[lane] = change + emission[lane];
        predecessor[lane] = 1 - lane;
      }
    }
    const current = next[0] <= next[1] ? 0 : 1;
    states.push(current);
    costs = next;
  }
  let sequenceSwitches = 0;
  for (let i = 1; i < states.length; i += 1) if (states[i] !== states[i - 1]) sequenceSwitches += 1;
  return { nearest: nearestSwitches, sequence: sequenceSwitches };
}

function processGpsMessage(bus) {
  const now = performance.now();
  if (bus.status === 2) return;

  if (now < bus.silenceUntil) {
    bus.status = 3;
    const elapsed = Math.min((now - bus.serverUpdatedAt) / 1000, 240);
    bus.progress = (bus.progress + bus.speedNormalized * elapsed) % 1;
    bus.serverUpdatedAt = now;
    return;
  }

  if (bus.status === 3) bus.status = 0;
  if (random() < 0.0005) {
    bus.silenceUntil = now + 40_000 + random() * 200_000;
    bus.status = 3;
    return;
  }

  const elapsedSeconds = Math.max(1, Math.min(35, (now - bus.serverUpdatedAt) / 1000));
  const actualProgress = (bus.progress + bus.speedNormalized * elapsedSeconds) % 1;
  const actualPoint = routePoint(bus.route, actualProgress);
  const isBounce = random() < 0.045;
  const noise = isBounce ? 0.003 : 0.00042;
  const gps = {
    x: actualPoint.x + gaussian() * noise,
    y: actualPoint.y + gaussian() * noise
  };

  let timestamp = Date.now() + bus.clockOffset;
  if (random() < 0.03) timestamp -= 45_000 + random() * 80_000;
  if (timestamp <= bus.lastTimestamp) {
    ignoredOutOfOrder += 1;
    return;
  }

  const candidates = findCandidates(gps.x, gps.y, bus.route);
  const matched = sequenceMatch(bus, candidates);
  recordTraversal(bus, Math.min(TRAVEL_SEGMENTS - 1, Math.floor(actualProgress * TRAVEL_SEGMENTS)), now);
  const wrapped = actualProgress < 0.08 && bus.progress > 0.92;
  if (wrapped) {
    bus.matchedProgress = matched.progress;
  } else {
    const monotonic = Math.max(bus.matchedProgress - 0.0008, matched.progress);
    bus.matchedProgress = Math.min(0.9999, monotonic);
  }

  bus.progress = actualProgress;
  bus.x = matched.x;
  bus.y = matched.y;
  bus.lastTimestamp = timestamp;
  bus.serverUpdatedAt = now;
  messageCounter += 1;
}

function programmedHeadway() {
  const hour = new Date().getHours();
  return (hour >= 6 && hour < 9) || (hour >= 16 && hour < 19) ? 6 : 12;
}

function calculateAlerts() {
  const headwayTarget = programmedHeadway();
  const cycleMinutes = headwayTarget * 14;
  const alerts = [];
  buses.forEach((bus) => { bus.risk = 0; });

  for (let route = 0; route < routeCount; route += 1) {
    const routeBuses = buses
      .filter((bus) => bus.route === route && bus.status !== 2)
      .sort((a, b) => a.progress - b.progress);
    if (routeBuses.length < 2) continue;

    for (let index = 0; index < routeBuses.length; index += 1) {
      const bus = routeBuses[index];
      const ahead = routeBuses[(index + 1) % routeBuses.length];
      const gap = (ahead.progress - bus.progress + 1) % 1;
      const interval = gap * cycleMinutes;
      const bunching = interval < headwayTarget * 0.4;
      const serviceGap = interval > headwayTarget * 1.6;
      if (!bunching && !serviceGap) continue;

      const type = bunching ? "bunching" : "gap";
      const severity = bunching
        ? Math.min(1, 1 - interval / (headwayTarget * 0.4))
        : Math.min(1, interval / (headwayTarget * 1.6) - 1);
      bus.risk = Math.max(bus.risk, 0.56 + severity * 0.44);
      const stop = Math.min(11, Math.max(1, Math.ceil(bus.progress * 11)));
      const retention = Math.max(1, Math.min(5, Math.round((headwayTarget - interval) * 0.55)));
      alerts.push({
        id: `${type}-${route}-${bus.id}`,
        type,
        route,
        bus: bus.id,
        stop,
        interval: Math.max(0.2, interval),
        target: headwayTarget,
        severity,
        confidence: 0.82 + random() * 0.15,
        age: Math.floor(random() * 25),
        recommendation: bunching
          ? `Retener ${retention} min en P-${String(route + 1).padStart(2, "0")}-${String(stop).padStart(2, "0")}; capacidad confirmada.`
          : `Priorizar despacho y evitar nuevas retenciones hasta recuperar el intervalo.`
      });
    }
  }

  const occupiedStops = new Set();
  alerts
    .sort((a, b) => b.severity - a.severity)
    .forEach((alert) => {
      if (alert.type !== "bunching") return;
      let key = `${alert.route % 6}:${alert.stop}`;
      if (occupiedStops.has(key)) {
        alert.stop = Math.min(11, alert.stop + 1);
        key = `${alert.route % 6}:${alert.stop}`;
        alert.recommendation = alert.recommendation.replace(/P-\d{2}-\d{2}/, `P-${String(alert.route + 1).padStart(2, "0")}-${String(alert.stop).padStart(2, "0")}`);
      }
      occupiedStops.add(key);
    });

  latestAlerts = alerts.sort((a, b) => b.severity - a.severity).slice(0, 12);
  postMessage({ type: "alerts", alerts: latestAlerts });
}

function fillFrame(target) {
  for (const bus of buses) {
    const offset = bus.id * STRIDE;
    const historyOffset = Math.min(HISTORY_SAMPLES - 1, Math.max(0, Math.round(-historyMinutes * 2)));
    const historyIndex = (historyCursor - historyOffset + HISTORY_SAMPLES) % HISTORY_SAMPLES;
    const viewedProgress = historyMinutes < 0
      ? historyBuffer[bus.id * HISTORY_SAMPLES + historyIndex]
      : bus.progress;
    const point = historyMinutes === 0 && Number.isFinite(bus.x) && bus.x !== 0
      ? { x: bus.x, y: bus.y }
      : routePoint(bus.route, viewedProgress);
    target[offset] = point.x;
    target[offset + 1] = point.y;
    target[offset + 2] = viewedProgress;
    target[offset + 3] = bus.route;
    target[offset + 4] = bus.speed;
    target[offset + 5] = bus.status;
    target[offset + 6] = bus.risk;
    target[offset + 7] = bus.lastTimestamp % 1_000_000_000;
  }
}

function publishFrame(now) {
  if (sharedBuffer) {
    const activeSlot = Atomics.load(header, 1);
    const writeSlot = activeSlot === 0 ? 1 : 0;
    fillFrame(sharedViews[writeSlot]);
    Atomics.store(header, 1, writeSlot);
    Atomics.add(header, 0, 1);
    Atomics.notify(header, 0);
  } else if (now - lastFallbackFrame > 65) {
    const frame = new Float32Array(busCount * STRIDE);
    fillFrame(frame);
    postMessage({ type: "frame", buffer: frame.buffer }, [frame.buffer]);
    lastFallbackFrame = now;
  }
}

function publishMetrics(now) {
  const elapsed = Math.max(0.2, (now - lastMetricsAt) / 1000);
  const active = buses.filter((bus) => bus.status !== 2).length;
  const routeHealth = Array.from({ length: routeCount }, (_, route) => {
    const routeAlerts = latestAlerts.filter((alert) => alert.route === route);
    return { route, risk: routeAlerts.length ? Math.max(...routeAlerts.map((alert) => 0.45 + alert.severity * 0.55)) : 0.08 + random() * 0.16 };
  });
  postMessage({
    type: "metrics",
    metrics: {
      active,
      risks: latestAlerts.filter((alert) => alert.type === "bunching").length,
      gaps: latestAlerts.filter((alert) => alert.type === "gap").length,
      messagesPerSecond: Math.round(messageCounter / elapsed),
      ignoredOutOfOrder,
      p50Seconds: histogramPercentile(travelHistograms[0], 0.5),
      p85Seconds: histogramPercentile(travelHistograms[0], 0.85),
      routeHealth
    }
  });
  messageCounter = 0;
  lastMetricsAt = now;
}

function tick() {
  const now = performance.now();
  if (!paused && historyMinutes === 0) {
    processGpsMessage(buses[cursor]);
    cursor = (cursor + 1) % busCount;
  }
  sampleHistory(now);
  if (now - lastAlertAt > 1000) {
    calculateAlerts();
    lastAlertAt = now;
  }
  publishFrame(now);
  if (now - lastMetricsAt > 1000) publishMetrics(now);
  setTimeout(tick, 32);
}

function forceBunching(route) {
  const candidates = buses.filter((bus) => bus.route === route && bus.status !== 2).sort((a, b) => a.progress - b.progress);
  if (candidates.length < 2) return;
  const anchor = candidates[Math.floor(candidates.length / 2)];
  const follower = candidates[Math.floor(candidates.length / 2) - 1];
  follower.progress = (anchor.progress - 0.004 + 1) % 1;
  follower.matchedProgress = follower.progress;
  follower.speed = Math.max(8, anchor.speed - 7);
  follower.speedNormalized = follower.speed / 18 / 3600;
  sequenceWindows[follower.id] = [];
  calculateAlerts();
}

function initialize(message) {
  busCount = message.busCount || busCount;
  routeCount = message.routeCount || routeCount;
  sharedBuffer = message.sharedBuffer || null;
  if (sharedBuffer) {
    const frameBytes = busCount * STRIDE * Float32Array.BYTES_PER_ELEMENT;
    header = new Int32Array(sharedBuffer, 0, HEADER_INTS);
    sharedViews = [
      new Float32Array(sharedBuffer, HEADER_BYTES, busCount * STRIDE),
      new Float32Array(sharedBuffer, HEADER_BYTES + frameBytes, busCount * STRIDE)
    ];
    Atomics.store(header, 1, 0);
  }
  createCartography();
  buildSpatialIndex();
  createFleet();
  buses.forEach((bus) => {
    const point = routePoint(bus.route, bus.progress);
    bus.x = point.x;
    bus.y = point.y;
  });
  calculateAlerts();
  publishFrame(performance.now());
  postMessage({ type: "ready", acceptance: runAcceptanceTest(), vertices: routeCount * ROUTE_VERTICES, gridCells: spatialIndex.size });
  tick();
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "init") initialize(message);
  if (message.type === "pause") paused = Boolean(message.value);
  if (message.type === "seek") {
    historyMinutes = Number(message.minutes) || 0;
    publishFrame(performance.now());
  }
  if (message.type === "forceBunching") forceBunching(Number(message.route) || 0);
});
