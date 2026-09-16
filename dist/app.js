const BUS_COUNT = 310;
const ROUTE_COUNT = 22;
const STRIDE = 8;
const HEADER_INTS = 16;
const HEADER_BYTES = HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const FRAME_FLOATS = BUS_COUNT * STRIDE;

const ROUTE_COLORS = [
  "#36d7c2", "#5fb8ff", "#f4b860", "#a68bff", "#ff7d88", "#45c8ef",
  "#80d585", "#e594d3", "#f29b61", "#6ce0a6", "#79a5ff"
];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const ui = {
  canvas: $("#fleetMap"),
  mapStage: $("#mapStage"),
  loading: $("#loadingLayer"),
  clock: $("#clock"),
  connectionPill: $("#connectionPill"),
  connectionLabel: $("#connectionLabel"),
  activeBuses: $("#activeBuses"),
  riskCount: $("#riskCount"),
  gapCount: $("#gapCount"),
  messageRate: $("#messageRate"),
  fps: $("#fps"),
  inp: $("#inp"),
  mapMatchScore: $("#mapMatchScore"),
  workerState: $("#workerState"),
  alertTotal: $("#alertTotal"),
  alertList: $("#alertList"),
  routeHealth: $("#routeHealth"),
  routeSelect: $("#routeSelect"),
  routeSummary: $("#routeSummary"),
  timeline: $("#timeline"),
  timelineLabel: $("#timelineLabel"),
  togglePause: $("#togglePause"),
  forceBunching: $("#forceBunching"),
  selectedBusCard: $("#selectedBusCard"),
  selectedBusId: $("#selectedBusId"),
  selectedBusRoute: $("#selectedBusRoute"),
  selectedBusSpeed: $("#selectedBusSpeed"),
  selectedBusProgress: $("#selectedBusProgress"),
  supervisorDialog: $("#supervisorDialog"),
  supervisorForm: $("#supervisorForm"),
  actionBus: $("#actionBus"),
  actionRoute: $("#actionRoute"),
  actionType: $("#actionType"),
  actionNote: $("#actionNote"),
  pendingActions: $("#pendingActions"),
  diagnosticsDialog: $("#diagnosticsDialog"),
  diagSharedMemory: $("#diagSharedMemory"),
  diagSwitches: $("#diagSwitches"),
  diagLongTasks: $("#diagLongTasks"),
  toastRegion: $("#toastRegion")
};

const ctx = ui.canvas.getContext("2d", { alpha: true, desynchronized: true });

const state = {
  worker: null,
  sharedWorker: null,
  sab: null,
  header: null,
  views: [],
  frame: new Float32Array(FRAME_FLOATS),
  sharedMode: false,
  alerts: [],
  alertFilter: "all",
  metrics: {
    active: 0,
    risks: 0,
    gaps: 0,
    messagesPerSecond: 0,
    routeHealth: []
  },
  selectedRoute: "all",
  selectedBus: -1,
  paused: false,
  historyMinutes: 0,
  routeGeometry: [],
  width: 0,
  height: 0,
  dpr: 1,
  renderedBuses: [],
  view: { scale: 1, x: 0, y: 0 },
  drag: null,
  fpsFrames: 0,
  fpsStarted: performance.now(),
  lastFps: 0,
  maxInp: 0,
  longTasks: 0,
  frameVersion: -1,
  ready: false
};

function routeLabel(route) {
  return `R-${String(route + 1).padStart(2, "0")}`;
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

function buildDisplayGeometry() {
  state.routeGeometry = Array.from({ length: ROUTE_COUNT }, (_, route) => {
    const points = [];
    for (let i = 0; i <= 240; i += 1) points.push(routePoint(route, i / 240));
    return points;
  });
}

function populateRouteControls() {
  const fragment = document.createDocumentFragment();
  const actionFragment = document.createDocumentFragment();
  for (let route = 0; route < ROUTE_COUNT; route += 1) {
    const option = document.createElement("option");
    option.value = String(route);
    option.textContent = `${routeLabel(route)} · Corredor ${Math.floor(route / 2) + 1}`;
    fragment.append(option);

    const actionOption = option.cloneNode(true);
    actionFragment.append(actionOption);
  }
  ui.routeSelect.append(fragment);
  ui.actionRoute.append(actionFragment);
}

function resizeCanvas() {
  const rect = ui.mapStage.getBoundingClientRect();
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  state.width = Math.max(1, rect.width);
  state.height = Math.max(1, rect.height);
  ui.canvas.width = Math.round(state.width * state.dpr);
  ui.canvas.height = Math.round(state.height * state.dpr);
  ui.canvas.style.width = `${state.width}px`;
  ui.canvas.style.height = `${state.height}px`;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
}

function screenPoint(point) {
  const base = Math.min(state.width, state.height * 1.58);
  return {
    x: state.width / 2 + (point.x - 0.5) * base * state.view.scale + state.view.x,
    y: state.height / 2 + (point.y - 0.5) * base * state.view.scale + state.view.y
  };
}

function drawBackgroundNetwork() {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(105, 145, 171, 0.075)";
  for (let i = 0; i < 18; i += 1) {
    const y = 0.08 + i * 0.05;
    ctx.beginPath();
    let first = true;
    for (let j = 0; j <= 24; j += 1) {
      const x = 0.03 + j * 0.04;
      const p = screenPoint({ x, y: y + Math.sin(j * 0.75 + i) * 0.006 });
      if (first) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
      first = false;
    }
    ctx.stroke();
  }
  for (let i = 0; i < 15; i += 1) {
    const x = 0.06 + i * 0.063;
    const a = screenPoint({ x, y: 0.04 });
    const b = screenPoint({ x: x + Math.sin(i) * 0.012, y: 0.96 });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRoutes() {
  const selected = state.selectedRoute === "all" ? null : Number(state.selectedRoute);
  for (let route = 0; route < ROUTE_COUNT; route += 1) {
    if (selected !== null && route !== selected) continue;
    const geometry = state.routeGeometry[route];
    ctx.beginPath();
    geometry.forEach((point, index) => {
      const p = screenPoint(point);
      if (index === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    const emphasized = selected === route;
    ctx.strokeStyle = ROUTE_COLORS[route % ROUTE_COLORS.length];
    ctx.globalAlpha = emphasized ? 0.72 : 0.16;
    ctx.lineWidth = emphasized ? 3.1 : 1.15;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if (selected !== null) {
    for (let i = 1; i < 12; i += 1) {
      const p = screenPoint(routePoint(selected, i / 12));
      if (p.x < -10 || p.x > state.width + 10 || p.y < -10 || p.y > state.height + 10) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.3, 0, Math.PI * 2);
      ctx.fillStyle = "#07111f";
      ctx.fill();
      ctx.strokeStyle = ROUTE_COLORS[selected % ROUTE_COLORS.length];
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }
}

function drawTrail(route, progress, speed, color) {
  const threeMinuteDistance = (speed / 18 / 3600) * 180;
  ctx.beginPath();
  for (let i = 8; i >= 0; i -= 1) {
    const p = screenPoint(routePoint(route, progress - (i / 8) * threeMinuteDistance));
    if (i === 8) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.24;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawBus(id, x, y, route, progress, speed, status, risk) {
  const selectedRoute = state.selectedRoute === "all" ? null : Number(state.selectedRoute);
  if (selectedRoute !== null && route !== selectedRoute) return;
  if (status === 2) return;

  const point = screenPoint({ x, y });
  if (point.x < -24 || point.x > state.width + 24 || point.y < -24 || point.y > state.height + 24) return;

  const next = screenPoint(routePoint(route, progress + 0.0008));
  const angle = Math.atan2(next.y - point.y, next.x - point.x);
  const color = status === 3 ? "#627687" : risk > 0.55 ? "#f4b860" : "#38d8c4";

  if (state.view.scale > 0.82 || selectedRoute !== null) drawTrail(route, progress, speed, color);

  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);
  if (id === state.selectedBus) {
    ctx.beginPath();
    ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(95, 184, 255, 0.18)";
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = risk > 0.55 ? 7 : 2;
  ctx.beginPath();
  ctx.roundRect(-4.4, -2.8, 8.8, 5.6, 1.8);
  ctx.fill();
  ctx.fillStyle = "#061018";
  ctx.fillRect(0.7, -1.4, 2.1, 2.8);
  ctx.restore();

  state.renderedBuses.push({ id, x: point.x, y: point.y, route, progress, speed, status, risk });
}

function getCurrentFrame() {
  if (!state.sharedMode || !state.header) return state.frame;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const versionBefore = Atomics.load(state.header, 0);
    const slot = Atomics.load(state.header, 1);
    const versionAfter = Atomics.load(state.header, 0);
    if (versionBefore === versionAfter && (slot === 0 || slot === 1)) {
      state.frameVersion = versionAfter;
      return state.views[slot];
    }
  }
  return state.views[Atomics.load(state.header, 1) === 1 ? 1 : 0];
}

function render() {
  state.fpsFrames += 1;
  const now = performance.now();
  if (now - state.fpsStarted >= 1000) {
    state.lastFps = Math.round((state.fpsFrames * 1000) / (now - state.fpsStarted));
    state.fpsFrames = 0;
    state.fpsStarted = now;
    ui.fps.textContent = String(state.lastFps);
  }

  ctx.clearRect(0, 0, state.width, state.height);
  drawBackgroundNetwork();
  drawRoutes();
  state.renderedBuses = [];

  const frame = getCurrentFrame();
  if (frame?.length >= FRAME_FLOATS) {
    for (let id = 0; id < BUS_COUNT; id += 1) {
      const offset = id * STRIDE;
      drawBus(
        id,
        frame[offset],
        frame[offset + 1],
        Math.round(frame[offset + 3]),
        frame[offset + 2],
        frame[offset + 4],
        Math.round(frame[offset + 5]),
        frame[offset + 6]
      );
    }
  }

  updateSelectedBus(frame);
  requestAnimationFrame(render);
}

function updateSelectedBus(frame) {
  if (state.selectedBus < 0 || !frame || frame.length < FRAME_FLOATS) return;
  const offset = state.selectedBus * STRIDE;
  const route = Math.round(frame[offset + 3]);
  ui.selectedBusId.textContent = `Bus ${String(state.selectedBus + 1).padStart(3, "0")}`;
  ui.selectedBusRoute.textContent = routeLabel(route);
  ui.selectedBusSpeed.textContent = `${Math.round(frame[offset + 4])} km/h`;
  ui.selectedBusProgress.textContent = `${Math.round(frame[offset + 2] * 18200)} m`;
}

function initWorker() {
  state.worker = new Worker(new URL("./simulation.worker.js", import.meta.url), { type: "module" });

  if (globalThis.crossOriginIsolated && "SharedArrayBuffer" in globalThis) {
    const frameBytes = FRAME_FLOATS * Float32Array.BYTES_PER_ELEMENT;
    state.sab = new SharedArrayBuffer(HEADER_BYTES + frameBytes * 2);
    state.header = new Int32Array(state.sab, 0, HEADER_INTS);
    state.views = [
      new Float32Array(state.sab, HEADER_BYTES, FRAME_FLOATS),
      new Float32Array(state.sab, HEADER_BYTES + frameBytes, FRAME_FLOATS)
    ];
    state.sharedMode = true;
    state.worker.postMessage({ type: "init", sharedBuffer: state.sab, busCount: BUS_COUNT, routeCount: ROUTE_COUNT });
  } else {
    state.worker.postMessage({ type: "init", sharedBuffer: null, busCount: BUS_COUNT, routeCount: ROUTE_COUNT });
  }

  state.worker.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "ready") {
      state.ready = true;
      ui.loading.classList.add("hidden");
      ui.workerState.textContent = "Procesamiento activo";
      ui.diagSharedMemory.textContent = state.sharedMode ? "Activa" : "Modo compatible";
      ui.diagSwitches.textContent = `${message.acceptance.sequence} falsos (vecino: ${message.acceptance.nearest})`;
      ui.mapMatchScore.textContent = `${message.acceptance.sequence}/${message.acceptance.nearest}`;
      showToast("Simulación lista: 310 buses conectados.");
    }
    if (message.type === "frame" && !state.sharedMode) {
      state.frame = new Float32Array(message.buffer);
    }
    if (message.type === "metrics") updateMetrics(message.metrics);
    if (message.type === "alerts") {
      state.alerts = message.alerts;
      renderAlerts();
    }
  });

  state.worker.addEventListener("error", () => {
    ui.workerState.textContent = "Error de simulación";
    showToast("No fue posible iniciar el simulador.");
  });

  if ("SharedWorker" in globalThis) {
    try {
      state.sharedWorker = new SharedWorker(new URL("./shared.worker.js", import.meta.url), { type: "module", name: "fleet-coordinator" });
      state.sharedWorker.port.start();
      state.sharedWorker.port.postMessage({ type: "hello", tab: crypto.randomUUID?.() || String(Date.now()) });
    } catch {
      state.sharedWorker = null;
    }
  }
}

function updateMetrics(metrics) {
  state.metrics = metrics;
  ui.activeBuses.textContent = String(metrics.active);
  ui.riskCount.textContent = String(metrics.risks);
  ui.gapCount.textContent = String(metrics.gaps);
  ui.messageRate.textContent = String(metrics.messagesPerSecond);
  renderRouteHealth(metrics.routeHealth || []);
}

function renderRouteHealth(health) {
  const ranked = [...health]
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 6);

  ui.routeHealth.innerHTML = ranked.map((item) => {
    const level = item.risk > 0.72 ? "danger" : item.risk > 0.38 ? "warning" : "";
    const regularity = Math.max(10, Math.round((1 - item.risk) * 100));
    return `
      <div class="route-row ${level}">
        <b>${routeLabel(item.route)}</b>
        <span class="health-track"><i style="width:${regularity}%"></i></span>
        <em>${regularity}%</em>
      </div>`;
  }).join("");
}

function renderAlerts() {
  const visible = state.alerts.filter((alert) => state.alertFilter === "all" || alert.type === state.alertFilter);
  ui.alertTotal.textContent = String(state.alerts.length);
  if (!visible.length) {
    ui.alertList.innerHTML = `
      <div class="empty-alerts">
        <span class="empty-icon">✓</span>
        <strong>Sin alertas en este filtro</strong>
        <p>La flota permanece dentro de los intervalos esperados.</p>
      </div>`;
    return;
  }

  ui.alertList.innerHTML = visible.map((alert) => `
    <article class="alert-card ${alert.type}" data-alert-id="${alert.id}">
      <header>
        <div><span class="eyebrow">${alert.type === "gap" ? "HUECO DE SERVICIO" : "AGRUPAMIENTO INMINENTE"}</span><h3>${routeLabel(alert.route)} · Bus ${String(alert.bus + 1).padStart(3, "0")}</h3></div>
        <time>${alert.age}s</time>
      </header>
      <p>Intervalo proyectado: <b>${alert.interval.toFixed(1)} min</b> · objetivo ${alert.target.toFixed(0)} min.</p>
      <div class="recommendation">${alert.recommendation}</div>
      <footer>
        <span>Confianza ${Math.round(alert.confidence * 100)}%</span>
        <button class="secondary-button apply-alert" data-alert-id="${alert.id}">Registrar acción</button>
      </footer>
    </article>`).join("");
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  ui.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function updateConnectionState() {
  const online = navigator.onLine;
  ui.connectionPill.classList.toggle("offline", !online);
  ui.connectionLabel.textContent = online ? "Conectado · tiempo real" : "Sin conexión · estado guardado";
  if (online) flushPendingActions();
}

function getPendingActions() {
  try {
    return JSON.parse(localStorage.getItem("fleet-supervisor-queue") || "[]");
  } catch {
    return [];
  }
}

function setPendingActions(actions) {
  localStorage.setItem("fleet-supervisor-queue", JSON.stringify(actions));
  ui.pendingActions.textContent = String(actions.length);
}

function queueSupervisorAction(action) {
  const actions = getPendingActions();
  actions.push({ ...action, id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, createdAt: new Date().toISOString() });
  setPendingActions(actions);
  navigator.serviceWorker?.controller?.postMessage({ type: "QUEUE_ACTION", action });
  showToast(navigator.onLine ? "Acción registrada y enviada." : "Acción guardada; se enviará al recuperar la señal.");
  if (navigator.onLine) window.setTimeout(flushPendingActions, 700);
}

function flushPendingActions() {
  const actions = getPendingActions();
  if (!actions.length || !navigator.onLine) return;
  setPendingActions([]);
  navigator.serviceWorker?.controller?.postMessage({ type: "FLUSH_ACTIONS" });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
    if (!globalThis.crossOriginIsolated && !navigator.serviceWorker.controller && !sessionStorage.getItem("fleet-coi-reload")) {
      sessionStorage.setItem("fleet-coi-reload", "1");
      navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
    } else if (globalThis.crossOriginIsolated) {
      sessionStorage.removeItem("fleet-coi-reload");
    }
  } catch {
    showToast("Modo offline no disponible en este navegador.");
  }
}

function initPerformanceMonitoring() {
  if (!("PerformanceObserver" in globalThis)) return;
  try {
    if (PerformanceObserver.supportedEntryTypes.includes("event")) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.interactionId && entry.duration > state.maxInp) {
            state.maxInp = Math.round(entry.duration);
            ui.inp.textContent = String(state.maxInp);
          }
        }
      });
      observer.observe({ type: "event", buffered: true, durationThreshold: 16 });
    }
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      const longTaskObserver = new PerformanceObserver((list) => {
        state.longTasks += list.getEntries().length;
        ui.diagLongTasks.textContent = String(state.longTasks);
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
    }
  } catch {
    ui.inp.textContent = "—";
  }
}

function openSupervisorWithAlert(alert = null) {
  if (alert) {
    ui.actionBus.value = String(alert.bus + 1);
    ui.actionRoute.value = String(alert.route);
    ui.actionType.value = "retention";
    ui.actionNote.value = alert.recommendation;
  }
  ui.supervisorDialog.showModal();
}

function bindEvents() {
  ui.routeSelect.addEventListener("change", () => {
    state.selectedRoute = ui.routeSelect.value;
    ui.routeSummary.textContent = state.selectedRoute === "all" ? "22 visibles" : routeLabel(Number(state.selectedRoute));
  });

  ui.forceBunching.addEventListener("click", () => {
    const route = state.selectedRoute === "all" ? 6 : Number(state.selectedRoute);
    state.worker?.postMessage({ type: "forceBunching", route });
    showToast(`Escenario forzado en ${routeLabel(route)}. La alerta aparecerá en segundos.`);
  });

  ui.togglePause.addEventListener("click", () => {
    state.paused = !state.paused;
    state.worker?.postMessage({ type: "pause", value: state.paused });
    ui.togglePause.querySelector("span").textContent = state.paused ? "Reanudar" : "Pausar";
    showToast(state.paused ? "Simulación pausada." : "Simulación reanudada.");
  });

  let seekFrame = 0;
  ui.timeline.addEventListener("input", () => {
    state.historyMinutes = Number(ui.timeline.value);
    const target = new Date(Date.now() + state.historyMinutes * 60_000);
    ui.timelineLabel.textContent = state.historyMinutes === 0
      ? "Ahora"
      : target.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
    cancelAnimationFrame(seekFrame);
    seekFrame = requestAnimationFrame(() => state.worker?.postMessage({ type: "seek", minutes: state.historyMinutes }));
  });

  $$(".filter-chip").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".filter-chip").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.alertFilter = button.dataset.filter;
      renderAlerts();
    });
  });

  ui.alertList.addEventListener("click", (event) => {
    const button = event.target.closest(".apply-alert");
    if (!button) return;
    const alert = state.alerts.find((item) => item.id === button.dataset.alertId);
    if (alert) openSupervisorWithAlert(alert);
  });

  [$("#openSupervisor"), $("#openSupervisorDesktop")].forEach((button) => button.addEventListener("click", () => openSupervisorWithAlert()));

  ui.supervisorForm.addEventListener("submit", (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    queueSupervisorAction({
      type: ui.actionType.value,
      bus: Number(ui.actionBus.value),
      route: Number(ui.actionRoute.value),
      note: ui.actionNote.value.trim()
    });
    ui.actionNote.value = "";
    ui.supervisorDialog.close();
  });

  $("#openDiagnostics").addEventListener("click", () => ui.diagnosticsDialog.showModal());
  $("#closeDiagnostics").addEventListener("click", () => ui.diagnosticsDialog.close());
  $("#closeBusCard").addEventListener("click", () => {
    state.selectedBus = -1;
    ui.selectedBusCard.hidden = true;
  });

  $("#zoomIn").addEventListener("click", () => { state.view.scale = Math.min(3.4, state.view.scale * 1.22); });
  $("#zoomOut").addEventListener("click", () => { state.view.scale = Math.max(0.72, state.view.scale / 1.22); });
  $("#resetView").addEventListener("click", () => { state.view = { scale: 1, x: 0, y: 0 }; });

  ui.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    state.view.scale = Math.min(3.4, Math.max(0.72, state.view.scale * factor));
  }, { passive: false });

  ui.canvas.addEventListener("pointerdown", (event) => {
    state.drag = { x: event.clientX, y: event.clientY, moved: false };
    ui.canvas.setPointerCapture(event.pointerId);
    ui.canvas.classList.add("dragging");
  });

  ui.canvas.addEventListener("pointermove", (event) => {
    if (!state.drag) return;
    const dx = event.clientX - state.drag.x;
    const dy = event.clientY - state.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) state.drag.moved = true;
    state.view.x += dx;
    state.view.y += dy;
    state.drag.x = event.clientX;
    state.drag.y = event.clientY;
  });

  ui.canvas.addEventListener("pointerup", (event) => {
    const wasMoved = state.drag?.moved;
    state.drag = null;
    ui.canvas.classList.remove("dragging");
    if (!wasMoved) selectNearestBus(event);
  });

  window.addEventListener("online", updateConnectionState);
  window.addEventListener("offline", updateConnectionState);
  new ResizeObserver(resizeCanvas).observe(ui.mapStage);
}

function selectNearestBus(event) {
  const rect = ui.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let nearest = null;
  let distance = 14;
  for (const bus of state.renderedBuses) {
    const current = Math.hypot(bus.x - x, bus.y - y);
    if (current < distance) {
      distance = current;
      nearest = bus;
    }
  }
  if (!nearest) return;
  state.selectedBus = nearest.id;
  ui.selectedBusCard.hidden = false;
}

function tickClock() {
  ui.clock.textContent = new Date().toLocaleTimeString("es-CO", { hour12: false });
}

async function init() {
  buildDisplayGeometry();
  populateRouteControls();
  bindEvents();
  initPerformanceMonitoring();
  resizeCanvas();
  setPendingActions(getPendingActions());
  updateConnectionState();
  tickClock();
  window.setInterval(tickClock, 1000);
  await registerServiceWorker();
  initWorker();
  requestAnimationFrame(render);
}

init();
