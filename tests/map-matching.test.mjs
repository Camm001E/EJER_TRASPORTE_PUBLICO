import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const csv = readFileSync(new URL("../data/trayecto_calles_paralelas.csv", import.meta.url), "utf8").trim();
const observations = csv.split("\n").slice(1).map((line) => {
  const [id, x, gpsY, expected] = line.split(",");
  return { id: Number(id), x: Number(x), y: Number(gpsY), expected };
});

const laneY = [0.49, 0.51];
const nearest = observations.map((point) => Math.abs(point.y - laneY[0]) <= Math.abs(point.y - laneY[1]) ? 0 : 1);

function countSwitches(states) {
  let switches = 0;
  for (let index = 1; index < states.length; index += 1) {
    if (states[index] !== states[index - 1]) switches += 1;
  }
  return switches;
}

let costs = [0, 0];
const sequence = [];
for (const point of observations) {
  const emission = laneY.map((y) => Math.abs(point.y - y) * 300);
  const next = [0, 0];
  for (let lane = 0; lane < 2; lane += 1) {
    next[lane] = Math.min(costs[lane], costs[1 - lane] + 9) + emission[lane];
  }
  sequence.push(next[0] <= next[1] ? 0 : 1);
  costs = next;
}

const nearestSwitches = countSwitches(nearest);
const sequenceSwitches = countSwitches(sequence);

assert.equal(nearestSwitches, 18, "La línea base debe reproducir 18 cambios falsos");
assert.ok(sequenceSwitches < 3, `La asignación secuencial debe producir menos de 3 cambios; produjo ${sequenceSwitches}`);
assert.ok(sequence.every((lane) => lane === 0), "El trayecto etiquetado debe permanecer en la calle A");

console.log(`Prueba aprobada: vecino más cercano=${nearestSwitches}; memoria de secuencia=${sequenceSwitches}.`);
