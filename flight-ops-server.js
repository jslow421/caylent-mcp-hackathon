#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const client = new DynamoDBClient({ region: "us-west-2" }); // Update region as needed
const docClient = DynamoDBDocumentClient.from(client);

const FLIGHTS_TABLE = "slowik-flight-test";
const PASSENGERS_TABLE = "slowik-passenger-test";

const server = new Server(
  {
    name: "airline-flight-ops",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle initialization
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  return {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "airline-flight-ops",
      version: "1.0.0",
    },
  };
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "check_flight_delays",
        description:
          "Check for delayed flights and affected passengers at Frankfurt hub",
        inputSchema: {
          type: "object",
          properties: {
            airport: {
              type: "string",
              description: "Airport code (default: FRA)",
              default: "FRA",
            },
            severity: {
              type: "string",
              description:
                "Delay severity: minor (30-60min), major (60-120min), severe (120min+)",
              enum: ["minor", "major", "severe", "all"],
            },
          },
        },
      },
      {
        name: "find_alternative_flights",
        description:
          "Find alternative flights for rebooking based on passenger tier",
        inputSchema: {
          type: "object",
          properties: {
            origin: { type: "string", description: "Origin airport code" },
            destination: {
              type: "string",
              description: "Destination airport code",
            },
            passenger_tier: {
              type: "string",
              description: "Passenger status level",
              enum: ["senator", "frequent_traveler", "regular"],
            },
            departure_preference: {
              type: "string",
              description: "Preferred departure timing",
              enum: ["earliest", "same_day", "flexible"],
            },
          },
          required: ["origin", "destination"],
        },
      },
      {
        name: "get_affected_passengers",
        description: "Get passengers affected by a specific flight delay",
        inputSchema: {
          type: "object",
          properties: {
            flight_number: {
              type: "string",
              description: "Flight number (e.g., LH441)",
            },
          },
          required: ["flight_number"],
        },
      },
      {
        name: "test_connection",
        description: "Test DynamoDB connection and table access",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "check_flight_delays":
      try {
        const airport = args?.airport || "FRA";
        const severity = args?.severity || "all";

        // Scan the flights table for delays
        const params = {
          TableName: FLIGHTS_TABLE,
          FilterExpression: "#origin = :airport AND #status = :status",
          ExpressionAttributeNames: {
            "#origin": "origin",
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":airport": airport,
            ":status": "delayed",
          },
        };

        // Add severity filter if specified
        if (severity !== "all") {
          let delayFilter = "";
          switch (severity) {
            case "minor":
              delayFilter = "#delayMinutes BETWEEN :min AND :max";
              params.ExpressionAttributeNames["#delayMinutes"] = "delayMinutes";
              params.ExpressionAttributeValues[":min"] = 30;
              params.ExpressionAttributeValues[":max"] = 60;
              break;
            case "major":
              delayFilter = "#delayMinutes BETWEEN :min AND :max";
              params.ExpressionAttributeNames["#delayMinutes"] = "delayMinutes";
              params.ExpressionAttributeValues[":min"] = 60;
              params.ExpressionAttributeValues[":max"] = 120;
              break;
            case "severe":
              delayFilter = "#delayMinutes > :min";
              params.ExpressionAttributeNames["#delayMinutes"] = "delayMinutes";
              params.ExpressionAttributeValues[":min"] = 120;
              break;
          }
          if (delayFilter) {
            params.FilterExpression += ` AND ${delayFilter}`;
          }
        }

        const result = await docClient.send(new ScanCommand(params));
        const flights = result.Items || [];

        // Add debug logging
        console.error(
          `DEBUG: Scanned ${result.ScannedCount || 0} items, found ${
            flights.length
          } delayed flights`
        );

        if (flights.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No delayed flights found at ${airport}. This could mean:\n- All flights are on time\n- Database connection issues\n- No flights scheduled from this airport\n\nScanned ${
                  result.ScannedCount || 0
                } total flight records.`,
              },
            ],
          };
        }

        const summary = {
          total_delays: flights.length,
          affected_passengers: flights.length * 150, // Estimate
          flights: flights.map((flight) => ({
            flightNumber: flight.flightNumber,
            origin: flight.origin,
            destination: flight.destination,
            status: flight.status,
            delayMinutes: flight.delayMinutes,
            reason: flight.reason,
            departure: flight.departure,
            arrival: flight.arrival,
          })),
        };

        return {
          content: [
            {
              type: "text",
              text: `Found ${
                flights.length
              } delayed flights at ${airport}:\n\n${JSON.stringify(
                summary,
                null,
                2
              )}`,
            },
          ],
        };
      } catch (error) {
        console.error(`ERROR in check_flight_delays: ${error.message}`, error);
        return {
          content: [
            {
              type: "text",
              text: `Database Error: ${error.message}\n\nPossible causes:\n- AWS credentials not configured\n- DynamoDB table "${FLIGHTS_TABLE}" doesn't exist\n- Insufficient permissions\n- Network connectivity issues\n\nPlease check your AWS configuration and ensure the DynamoDB tables exist.`,
            },
          ],
        };
      }

    case "find_alternative_flights":
      try {
        const {
          origin,
          destination,
          passenger_tier = "regular",
          departure_preference = "earliest",
        } = args || {};

        if (!origin || !destination) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Origin and destination are required",
              },
            ],
          };
        }

        const params = {
          TableName: FLIGHTS_TABLE,
          FilterExpression:
            "#origin = :origin AND destination = :destination AND #status = :status",
          ExpressionAttributeNames: {
            "#origin": "origin",
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":origin": origin,
            ":destination": destination,
            ":status": "on_time",
          },
        };

        const result = await docClient.send(new ScanCommand(params));
        let flights = result.Items || [];

        // Sort by departure time (earliest first)
        flights.sort((a, b) => new Date(a.departure) - new Date(b.departure));

        // Limit to 5 results
        flights = flights.slice(0, 5);

        const alternatives = {
          passenger_tier,
          origin,
          destination,
          options: flights.map((flight) => ({
            flightNumber: flight.flightNumber,
            origin: flight.origin,
            destination: flight.destination,
            departure: flight.departure,
            arrival: flight.arrival,
            aircraft: flight.aircraft,
            status: flight.status,
            recommendation_reason:
              passenger_tier === "senator"
                ? "Premium service prioritized for Senator status"
                : passenger_tier === "frequent_traveler"
                ? "Earliest available departure for frequent traveler"
                : "Available alternative flight",
          })),
        };

        return {
          content: [
            {
              type: "text",
              text: `Found ${
                flights.length
              } alternative flights for ${passenger_tier} passenger:\n\n${JSON.stringify(
                alternatives,
                null,
                2
              )}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
        };
      }

    case "get_affected_passengers":
      try {
        const { flight_number } = args || {};

        if (!flight_number) {
          return {
            content: [
              { type: "text", text: "Error: Flight number is required" },
            ],
          };
        }

        const params = {
          TableName: PASSENGERS_TABLE,
          FilterExpression: "currentBooking.flightNumber = :flightNumber",
          ExpressionAttributeValues: {
            ":flightNumber": flight_number,
          },
        };

        const result = await docClient.send(new ScanCommand(params));
        const passengers = result.Items || [];

        // Sort by tier for prioritized handling
        const sortedPassengers = passengers.sort((a, b) => {
          const tierOrder = { senator: 3, frequent_traveler: 2, regular: 1 };
          return (
            (tierOrder[b.frequentFlyerTier] || 0) -
            (tierOrder[a.frequentFlyerTier] || 0)
          );
        });

        return {
          content: [
            {
              type: "text",
              text: `Found ${
                passengers.length
              } passengers on flight ${flight_number}:\n\n${JSON.stringify(
                sortedPassengers,
                null,
                2
              )}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
        };
      }

    case "test_connection":
      try {
        // Test both tables exist and are accessible
        const flightsTest = await docClient.send(
          new ScanCommand({
            TableName: FLIGHTS_TABLE,
            Limit: 1,
          })
        );

        const passengersTest = await docClient.send(
          new ScanCommand({
            TableName: PASSENGERS_TABLE,
            Limit: 1,
          })
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ Database Connection Test Results:
              
Flights table (${FLIGHTS_TABLE}): 
- Accessible: Yes
- Sample records: ${flightsTest.Items?.length || 0}
- Total scanned: ${flightsTest.ScannedCount || 0}

Passengers table (${PASSENGERS_TABLE}):
- Accessible: Yes  
- Sample records: ${passengersTest.Items?.length || 0}
- Total scanned: ${passengersTest.ScannedCount || 0}

AWS Region: us-west-2
Connection: Successful`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Database Connection Test Failed:

Error: ${error.message}
Error Code: ${error.name}

Troubleshooting:
1. Check AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
2. Verify tables exist: ${FLIGHTS_TABLE}, ${PASSENGERS_TABLE}
3. Check IAM permissions for DynamoDB access
4. Confirm region is correct (currently: us-west-2)`,
            },
          ],
        };
      }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Airline Flight Operations MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
