#!/usr/bin/env node
/* HTTP forwarder that rewrites Host to the loopback target, so containers can
   reach a host service that rejects cross-origin Host headers (OpenCodex).
   Usage: node http-bridge.mjs 0.0.0.0:10102 127.0.0.1:10101 */
import http from "node:http";

const [listenSpec, targetSpec] = process.argv.slice(2);
if (!listenSpec || !targetSpec) {
  console.error("usage: http-bridge.mjs <listenHost:port> <targetHost:port>");
  process.exit(2);
}
const [listenHost, listenPort] = listenSpec.split(":");
const [targetHost, targetPort] = targetSpec.split(":");
const loopbackHost = `127.0.0.1:${targetPort}`;

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: loopbackHost };
  delete headers.origin;
  const upstream = http.request(
    { host: targetHost, port: Number(targetPort), method: req.method, path: req.url, headers },
    (ures) => {
      res.writeHead(ures.statusCode || 502, ures.headers);
      ures.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  });
  req.pipe(upstream);
});

server.listen(Number(listenPort), listenHost, () => console.log(`http-bridge ${listenSpec} -> ${targetSpec} (Host=${loopbackHost})`));
