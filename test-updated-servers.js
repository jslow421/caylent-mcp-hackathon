#!/usr/bin/env node

/**
 * Test script for the updated MCP servers using new DynamoDB schemas
 */

import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test configurations
const tests = [
  {
    name: "Flight Operations Server - Test Connection",
    server: join(__dirname, "flight-ops-server.js"),
    tool: "test_connection",
    args: {},
  },
  {
    name: "Flight Operations Server - Check Flight Delays",
    server: join(__dirname, "flight-ops-server.js"),
    tool: "check_flight_delays",
    args: {
      airport: "FRA",
      severity: "all",
    },
  },
  {
    name: "Customer Service Server - Generate Proactive Message",
    server: join(__dirname, "customer-service-server.js"),
    tool: "generate_proactive_message",
    args: {
      passenger_id: "test123",
      delay_info: {
        flight_number: "LH441",
        reason: "weather",
        delay_minutes: 45,
      },
      message_tone: "solution_focused",
    },
  },
  {
    name: "Customer Service Server - Create Delay Notification",
    server: join(__dirname, "customer-service-server.js"),
    tool: "create_delay_notification",
    args: {
      passenger_id: "test123",
      flight_number: "LH441",
      delay_minutes: 45,
      notification_type: "email",
      message_content: "Your flight has been delayed.",
    },
  },
];

async function testMCPServer(testConfig) {
  return new Promise((resolve, reject) => {
    console.log(`\n🧪 Testing: ${testConfig.name}`);
    console.log(`📡 Server: ${testConfig.server}`);
    console.log(`🔧 Tool: ${testConfig.tool}`);
    console.log(`📋 Args: ${JSON.stringify(testConfig.args, null, 2)}`);

    const serverProcess = spawn("node", [testConfig.server], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    serverProcess.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    serverProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // Send MCP messages
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    };

    const toolCallRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: testConfig.tool,
        arguments: testConfig.args,
      },
    };

    serverProcess.stdin.write(JSON.stringify(initRequest) + "\n");

    setTimeout(() => {
      serverProcess.stdin.write(JSON.stringify(toolCallRequest) + "\n");

      setTimeout(() => {
        serverProcess.kill();

        console.log(`✅ Test completed for: ${testConfig.name}`);
        console.log(
          `📤 STDOUT: ${stdout.substring(0, 500)}${
            stdout.length > 500 ? "..." : ""
          }`
        );
        console.log(
          `⚠️  STDERR: ${stderr.substring(0, 200)}${
            stderr.length > 200 ? "..." : ""
          }`
        );

        resolve({
          name: testConfig.name,
          stdout,
          stderr,
          success: !stderr.includes("Error") && stdout.length > 0,
        });
      }, 2000);
    }, 1000);

    serverProcess.on("error", (err) => {
      console.error(`❌ Failed to start server: ${err.message}`);
      reject(err);
    });
  });
}

async function runAllTests() {
  console.log("🚀 Starting MCP Server Tests with Updated Schemas\n");
  console.log("=".repeat(60));

  const results = [];

  for (const test of tests) {
    try {
      const result = await testMCPServer(test);
      results.push(result);
    } catch (error) {
      console.error(`❌ Test failed: ${test.name}`, error);
      results.push({
        name: test.name,
        success: false,
        error: error.message,
      });
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 TEST SUMMARY");
  console.log("=".repeat(60));

  results.forEach((result) => {
    const status = result.success ? "✅ PASS" : "❌ FAIL";
    console.log(`${status} ${result.name}`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  });

  const passCount = results.filter((r) => r.success).length;
  console.log(`\n🎯 Results: ${passCount}/${results.length} tests passed`);

  if (passCount === results.length) {
    console.log(
      "🎉 All tests passed! The updated servers are working correctly."
    );
  } else {
    console.log(
      "⚠️  Some tests failed. Check AWS credentials and DynamoDB table setup."
    );
  }
}

runAllTests().catch(console.error);
