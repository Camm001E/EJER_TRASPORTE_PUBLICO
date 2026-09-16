import assert from "node:assert/strict";

let messageHandler = null;
const received = [];

globalThis.self = {
  addEventListener(type, handler) {
    if (type === "message") messageHandler = handler;
  }
};
globalThis.postMessage = (message) => received.push(message);

await import(new URL("../dist/simulation.worker.js", import.meta.url));
assert.equal(typeof messageHandler, "function", "El Worker debe registrar su receptor de mensajes");

messageHandler({ data: { type: "init", sharedBuffer: null, busCount: 310, routeCount: 22 } });

await new Promise((resolve) => setTimeout(resolve, 1_250));

const ready = received.find((message) => message.type === "ready");
const frame = received.find((message) => message.type === "frame");
const metrics = received.find((message) => message.type === "metrics");
const alerts = received.find((message) => message.type === "alerts");

assert.ok(ready, "El simulador debe anunciar que terminó de inicializar");
assert.equal(ready.vertices, 40_040, "La cartografía debe contener 40.040 vértices");
assert.ok(ready.acceptance.sequence < 3, "La prueba de calles paralelas debe quedar debajo de tres cambios falsos");
assert.ok(frame?.buffer instanceof ArrayBuffer, "El modo compatible debe publicar un cuadro binario");
assert.equal(frame.buffer.byteLength, 310 * 8 * 4, "El cuadro debe contener los ocho campos de los 310 buses");
assert.ok(metrics?.metrics.active > 250, "La mayoría de la flota debe estar activa");
assert.ok(Array.isArray(alerts?.alerts), "El Worker debe publicar alertas");

console.log(`Worker aprobado: ${ready.vertices} vértices, ${metrics.metrics.active} buses activos, ${alerts.alerts.length} alertas.`);
process.exit(0);
