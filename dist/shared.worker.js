const ports = new Set();
let lastSummary = { tabs: 0, updatedAt: Date.now() };

self.onconnect = (event) => {
  const port = event.ports[0];
  ports.add(port);
  lastSummary = { tabs: ports.size, updatedAt: Date.now() };

  port.onmessage = (messageEvent) => {
    const message = messageEvent.data;
    if (message.type === "hello") {
      port.postMessage({ type: "coordinator-ready", ...lastSummary });
    }
    if (message.type === "summary") {
      lastSummary = { ...message.summary, tabs: ports.size, updatedAt: Date.now() };
      for (const client of ports) {
        if (client !== port) client.postMessage({ type: "summary", summary: lastSummary });
      }
    }
  };

  port.onmessageerror = () => ports.delete(port);
  port.start();
};
