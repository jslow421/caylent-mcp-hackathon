#!/usr/bin/env node

import { spawn } from "child_process";
import { createReadStream } from "fs";

// Test the MCP server
const server = spawn("node", ["flight-ops-server.js"], {
  stdio: ["pipe", "pipe", "pipe"],
});

// Test initialize request
const initRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "test-client",
      version: "1.0.0",
    },
  },
};

// Test tools list request
const toolsRequest = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
};

server.stdout.on("data", (data) => {
  console.log("Server response:", data.toString());
});

server.stderr.on("data", (data) => {
  console.error("Server error:", data.toString());
});

server.on("close", (code) => {
  console.log(`Server exited with code ${code}`);
});

// Send initialize request
setTimeout(() => {
  console.log("Sending initialize request...");
  server.stdin.write(JSON.stringify(initRequest) + "\n");
}, 100);

// Send tools list request
setTimeout(() => {
  console.log("Sending tools list request...");
  server.stdin.write(JSON.stringify(toolsRequest) + "\n");
}, 500);

// Cleanup
setTimeout(() => {
  server.kill();
}, 2000);
