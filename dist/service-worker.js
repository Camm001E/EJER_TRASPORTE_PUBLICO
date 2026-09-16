const CACHE_NAME = "fleet-control-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./simulation.worker.js",
  "./shared.worker.js",
  "./manifest.webmanifest"
];

function withIsolationHeaders(response) {
  if (!response || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (request.method === "GET" && response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return withIsolationHeaders(response);
    } catch {
      const cached = await caches.match(request, { ignoreSearch: true })
        || (request.mode === "navigate" ? await caches.match("./index.html") : null);
      return cached ? withIsolationHeaders(cached) : new Response("Sin conexión", { status: 503 });
    }
  })());
});

function openQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("fleet-supervisor", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("actions")) {
        request.result.createObjectStore("actions", { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function addAction(action) {
  const db = await openQueue();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("actions", "readwrite");
    transaction.objectStore("actions").add({ ...action, queuedAt: Date.now() });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function clearActions() {
  const db = await openQueue();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("actions", "readwrite");
    transaction.objectStore("actions").clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "QUEUE_ACTION") event.waitUntil(addAction(event.data.action));
  if (event.data?.type === "FLUSH_ACTIONS") event.waitUntil(clearActions());
});

self.addEventListener("sync", (event) => {
  if (event.tag === "fleet-actions") event.waitUntil(clearActions());
});
