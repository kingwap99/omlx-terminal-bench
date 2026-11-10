#!/usr/bin/env node
/* Minimal TCP forwarder: lets Docker containers reach a host service that only
   listens on loopback (e.g. OpenCodex 127.0.0.1:10101).
   Usage: node port-bridge.mjs 0.0.0.0:10102 127.0.0.1:10101 */
import net from "node:net";

const [listenSpec, targetSpec] = process.argv.slice(2);
if (!listenSpec || !targetSpec) {
  console.error("usage: port-bridge.mjs <listenHost:port> <targetHost:port>");
  process.exit(2);
}
const [listenHost, listenPort] = listenSpec.split(":");
const [targetHost, targetPort] = targetSpec.split(":");

const server = net.createServer((client) => {
  const upstream = net.connect(Number(targetPort), targetHost);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});

server.listen(Number(listenPort), listenHost, () => {
  console.log(`bridge ${listenSpec} -> ${targetSpec}`);
});
