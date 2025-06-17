#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
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

const client = new DynamoDBClient({ region: "us-east-1" }); // Updated to match schema region
const docClient = DynamoDBDocumentClient.from(client);

// Updated table names to match new schemas
const FLIGHTS_TABLE = "Flights";
const PASSENGERS_TABLE = "Passengers";
const BOOKINGS_TABLE = "Bookings";
const DELAY_NOTIFICATIONS_TABLE = "DelayNotifications";
const REBOOKING_OPTIONS_TABLE = "RebookingOptions";

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
          "Check flights.Status field for delayed, cancelled, or diverted flights and affected passengers at Frankfurt hub",
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
                "Delay severity: minor (30-60min), major (60-120min), severe (120min+, cancelled, diverted)",
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

        // Check flights.Status field for delay-related statuses (handle both uppercase and lowercase)
        // First, get all flights and filter by delay-related statuses
        const scanParams = {
          TableName: FLIGHTS_TABLE,
          FilterExpression:
            "#status IN (:delayed, :delayedUpper, :cancelled, :cancelledUpper, :diverted, :divertedUpper) OR (attribute_exists(DelayMinutes) AND DelayMinutes > :minDelay)",
          ExpressionAttributeNames: {
            "#status": "Status",
          },
          ExpressionAttributeValues: {
            ":delayed": "delayed",
            ":delayedUpper": "DELAYED",
            ":cancelled": "cancelled",
            ":cancelledUpper": "CANCELLED",
            ":diverted": "diverted",
            ":divertedUpper": "DIVERTED",
            ":minDelay": 0,
          },
        };

        // Apply airport filter if specified
        if (airport !== "all") {
          scanParams.FilterExpression += " AND Origin = :airport";
          scanParams.ExpressionAttributeValues[":airport"] = String(airport);
        }

        const result = await docClient.send(new ScanCommand(scanParams));
        let flights = result.Items || [];

        // Apply severity filter if specified and filter for actual delays
        if (severity !== "all") {
          flights = flights.filter((flight) => {
            const delayMinutes = flight.DelayMinutes || 0;
            // Only consider flights with actual delays (positive DelayMinutes or delay-related status)
            const hasDelay = delayMinutes > 0 || isDelayedStatus(flight.Status);

            if (!hasDelay) return false;

            const statusLower = flight.Status
              ? flight.Status.toLowerCase()
              : "";
            switch (severity) {
              case "minor":
                return delayMinutes >= 30 && delayMinutes <= 60;
              case "major":
                return delayMinutes > 60 && delayMinutes <= 120;
              case "severe":
                return (
                  delayMinutes > 120 ||
                  statusLower === "cancelled" ||
                  statusLower === "diverted"
                );
              default:
                return true;
            }
          });
        } else {
          // For "all" severity, still filter to only include actual delays
          flights = flights.filter((flight) => {
            const delayMinutes = flight.DelayMinutes || 0;
            return delayMinutes > 0 || isDelayedStatus(flight.Status);
          });
        }

        // Add debug logging
        console.error(
          `DEBUG: Found ${flights.length} delayed/disrupted flights at ${airport} (checking Status field case-insensitively for: delayed, cancelled, diverted)`
        );

        if (flights.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No delayed, cancelled, or diverted flights found at ${airport}. Checked flights.Status field for delay-related statuses. This could mean:\n- All flights are on time (Status: "on_time")\n- Database connection issues\n- No flights scheduled from this airport`,
              },
            ],
          };
        }

        const summary = {
          total_delays: flights.length,
          affected_passengers: flights.length * 150, // Estimate
          flights: flights.map((flight) => ({
            flightNumber: flight.FlightNumber,
            origin: flight.Origin,
            destination: flight.Destination,
            status: flight.Status,
            delayMinutes: flight.DelayMinutes,
            reason: flight.DelayReason,
            scheduledDeparture: flight.ScheduledDepartureTime,
            estimatedDeparture: flight.EstimatedDepartureTime,
          })),
        };

        return {
          content: [
            {
              type: "text",
              text: `Found ${
                flights.length
              } delayed/disrupted flights at ${airport} (based on flights.Status field):\n\n${JSON.stringify(
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
        const { origin, destination, passenger_tier = "regular" } = args || {};

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
            "Origin = :origin AND Destination = :destination AND (#status = :onTime OR #status = :onTimeUpper OR #status = :scheduled OR #status = :scheduledUpper)",
          ExpressionAttributeNames: {
            "#status": "Status",
          },
          ExpressionAttributeValues: {
            ":origin": String(origin),
            ":destination": String(destination),
            ":onTime": "on_time",
            ":onTimeUpper": "ON_TIME",
            ":scheduled": "scheduled",
            ":scheduledUpper": "SCHEDULED",
          },
        };

        const result = await docClient.send(new ScanCommand(params));
        let flights = result.Items || [];

        // Sort by departure time (earliest first)
        flights.sort(
          (a, b) =>
            new Date(a.ScheduledDepartureTime) -
            new Date(b.ScheduledDepartureTime)
        );

        // Limit to 5 results
        flights = flights.slice(0, 5);

        const alternatives = {
          passenger_tier: String(passenger_tier),
          origin: String(origin),
          destination: String(destination),
          options: flights.map((flight) => ({
            flightNumber: flight.FlightNumber,
            origin: flight.Origin,
            destination: flight.Destination,
            scheduledDeparture: flight.ScheduledDepartureTime,
            scheduledArrival: flight.ScheduledArrivalTime,
            aircraft: flight.AircraftType,
            status: flight.Status,
            availableSeats: flight.AvailableSeats,
            recommendation_reason: getRecommendationReason(passenger_tier),
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

        // Query the Bookings table using the FlightBookingsIndex GSI
        const params = {
          TableName: BOOKINGS_TABLE,
          IndexName: "FlightBookingsIndex",
          KeyConditionExpression: "FlightNumber = :flightNumber",
          ExpressionAttributeValues: {
            ":flightNumber": String(flight_number),
          },
        };

        const result = await docClient.send(new QueryCommand(params));
        const bookings = result.Items || [];

        // Get passenger details for each booking
        const passengerPromises = bookings.map(async (booking) => {
          const passengerParams = {
            TableName: PASSENGERS_TABLE,
            Key: {
              PassengerId: booking.PassengerId,
              BookingReference: booking.BookingReference,
            },
          };

          try {
            const passengerResult = await docClient.send(
              new GetCommand(passengerParams)
            );
            return passengerResult.Item;
          } catch (error) {
            console.error(
              `Error fetching passenger ${booking.PassengerId}:`,
              error
            );
            return null;
          }
        });

        const passengers = (await Promise.all(passengerPromises)).filter(
          (p) => p !== null
        );

        // Sort by tier for prioritized handling
        const sortedPassengers = passengers.sort((a, b) => {
          const tierOrder = { senator: 3, frequent_traveler: 2, regular: 1 };
          return (
            (tierOrder[b.FrequentFlyerTier] || 0) -
            (tierOrder[a.FrequentFlyerTier] || 0)
          );
        });

        return {
          content: [
            {
              type: "text",
              text: `Found ${passengers.length} passengers on flight ${String(
                flight_number
              )}:\n\n${JSON.stringify(sortedPassengers, null, 2)}`,
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
        // Test all tables exist and are accessible
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

        const bookingsTest = await docClient.send(
          new ScanCommand({
            TableName: BOOKINGS_TABLE,
            Limit: 1,
          })
        );

        const delayNotificationsTest = await docClient.send(
          new ScanCommand({
            TableName: DELAY_NOTIFICATIONS_TABLE,
            Limit: 1,
          })
        );

        const rebookingOptionsTest = await docClient.send(
          new ScanCommand({
            TableName: REBOOKING_OPTIONS_TABLE,
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

Bookings table (${BOOKINGS_TABLE}):
- Accessible: Yes  
- Sample records: ${bookingsTest.Items?.length || 0}
- Total scanned: ${bookingsTest.ScannedCount || 0}

DelayNotifications table (${DELAY_NOTIFICATIONS_TABLE}):
- Accessible: Yes  
- Sample records: ${delayNotificationsTest.Items?.length || 0}
- Total scanned: ${delayNotificationsTest.ScannedCount || 0}

RebookingOptions table (${REBOOKING_OPTIONS_TABLE}):
- Accessible: Yes  
- Sample records: ${rebookingOptionsTest.Items?.length || 0}
- Total scanned: ${rebookingOptionsTest.ScannedCount || 0}

AWS Region: us-east-1
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
2. Verify tables exist: ${FLIGHTS_TABLE}, ${PASSENGERS_TABLE}, ${BOOKINGS_TABLE}, ${DELAY_NOTIFICATIONS_TABLE}, ${REBOOKING_OPTIONS_TABLE}
3. Check IAM permissions for DynamoDB access
4. Confirm region is correct (currently: us-east-1)`,
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

function getRecommendationReason(passenger_tier) {
  switch (passenger_tier) {
    case "senator":
      return "Premium service prioritized for Senator status";
    case "frequent_traveler":
      return "Earliest available departure for frequent traveler";
    default:
      return "Available alternative flight";
  }
}

// Helper function to check flight status case-insensitively
function isDelayedStatus(status) {
  if (!status) return false;
  const statusLower = status.toLowerCase();
  return (
    statusLower === "delayed" ||
    statusLower === "cancelled" ||
    statusLower === "diverted"
  );
}

function isOnTimeStatus(status) {
  if (!status) return false;
  const statusLower = status.toLowerCase();
  return (
    statusLower === "on_time" ||
    statusLower === "on-time" ||
    statusLower === "scheduled"
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Airline Flight Operations MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
