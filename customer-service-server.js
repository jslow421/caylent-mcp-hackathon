#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const client = new DynamoDBClient({ region: "us-east-1" }); // Updated to match schema region
const docClient = DynamoDBDocumentClient.from(client);

// Updated table names to match new schemas
const PASSENGERS_TABLE = "Passengers";
const BOOKINGS_TABLE = "Bookings";
const DELAY_NOTIFICATIONS_TABLE = "DelayNotifications";
const REBOOKING_OPTIONS_TABLE = "RebookingOptions";
const CUSTOMER_SUPPORT_SESSIONS_TABLE = "CustomerSupportSessions";

const server = new Server(
  {
    name: "airline-customer-service",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "generate_proactive_message",
        description:
          "Generate personalized proactive message for delayed flight passengers",
        inputSchema: {
          type: "object",
          properties: {
            passenger_id: { type: "string" },
            delay_info: { type: "object" },
            alternatives: { type: "array" },
            message_tone: {
              type: "string",
              enum: ["apologetic", "solution_focused", "premium_service"],
              default: "solution_focused",
            },
          },
          required: ["passenger_id", "delay_info"],
        },
      },
      {
        name: "create_rebooking_workflow",
        description:
          "Create step-by-step rebooking workflow for customer service",
        inputSchema: {
          type: "object",
          properties: {
            passenger_id: { type: "string" },
            selected_alternative: { type: "object" },
            additional_services: {
              type: "array",
              items: { type: "string" },
              description:
                "Additional services like lounge access, meal vouchers",
            },
          },
          required: ["passenger_id", "selected_alternative"],
        },
      },
      {
        name: "escalation_handoff",
        description: "Prepare context for human agent handoff",
        inputSchema: {
          type: "object",
          properties: {
            passenger_id: { type: "string" },
            issue_complexity: {
              type: "string",
              enum: [
                "simple_rebooking",
                "complex_itinerary",
                "compensation_required",
                "vip_handling",
              ],
            },
            conversation_history: { type: "array" },
          },
          required: ["passenger_id", "issue_complexity"],
        },
      },
      {
        name: "create_delay_notification",
        description:
          "Create a delay notification record for tracking and follow-up",
        inputSchema: {
          type: "object",
          properties: {
            passenger_id: { type: "string" },
            flight_number: { type: "string" },
            delay_minutes: { type: "number" },
            notification_type: {
              type: "string",
              enum: ["sms", "email", "push", "call"],
            },
            message_content: { type: "string" },
          },
          required: ["passenger_id", "flight_number", "delay_minutes"],
        },
      },
      {
        name: "start_support_session",
        description:
          "Start a new customer support session and track interaction",
        inputSchema: {
          type: "object",
          properties: {
            passenger_id: { type: "string" },
            issue_type: {
              type: "string",
              enum: [
                "flight_delay",
                "rebooking",
                "compensation",
                "general_inquiry",
              ],
            },
            initial_context: { type: "string" },
            agent_id: { type: "string" },
          },
          required: ["passenger_id", "issue_type"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "generate_proactive_message":
      try {
        // Get passenger by ID using the new schema structure
        const params = {
          TableName: PASSENGERS_TABLE,
          FilterExpression: "PassengerId = :id",
          ExpressionAttributeValues: {
            ":id": String(args.passenger_id),
          },
        };

        const result = await docClient.send(new ScanCommand(params));
        const passengers = result.Items || [];

        if (passengers.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Passenger ${String(args.passenger_id)} not found`,
              },
            ],
          };
        }

        const passenger = passengers[0];
        const tier = passenger?.FrequentFlyerTier || "regular";

        let message = "";

        if (tier === "senator") {
          message = `Dear Valued Senator Member,

I wanted to personally reach out about your flight ${
            args.delay_info.flight_number
          }.

Due to ${args.delay_info.reason}, your departure has been delayed by ${
            args.delay_info.delay_minutes
          } minutes. I've already identified several premium alternatives that prioritize your schedule and comfort preferences.

${
  args.alternatives
    ? "Your priority rebooking options:"
    : "I'm currently securing the best alternatives for you."
}

As our way of apologizing for this inconvenience, I'll ensure you receive:
- Priority rebooking on your preferred flight
- Lounge access during your wait
- Meal vouchers for any extended delays

Would you like me to proceed with rebooking, or would you prefer to speak with our premium service team?

Best regards,
Lufthansa Customer Care`;
        } else {
          message = `Hello,

Your flight ${args.delay_info.flight_number} has been delayed by ${args.delay_info.delay_minutes} minutes due to ${args.delay_info.reason}.

I've found several alternative flights that can get you to your destination. You can:

1. Select from the alternatives I'll show you
2. Keep your original booking (new departure time: [calculated time])
3. Speak with our customer service team

Let me know your preference and I'll take care of the rest!

Safe travels,
Lufthansa`;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  passenger_tier: tier,
                  message_type: "proactive_delay_notification",
                  message: message,
                  recommended_actions: [
                    "Present alternative flights",
                    "Offer compensation if applicable",
                    "Provide rebooking options",
                  ],
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
        };
      }

    case "create_rebooking_workflow":
      try {
        const {
          passenger_id,
          selected_alternative,
          additional_services = [],
        } = args;

        const workflow = {
          workflow_id: `WF_${Date.now()}`,
          passenger_id,
          steps: [
            {
              step: 1,
              action: "Cancel original booking",
              details: `Cancel existing reservation for passenger ${String(
                passenger_id
              )}`,
            },
            {
              step: 2,
              action: "Book alternative flight",
              details: `Book ${selected_alternative.flight_number} from ${selected_alternative.origin} to ${selected_alternative.destination}`,
            },
            {
              step: 3,
              action: "Process seat assignment",
              details: "Assign preferred seat based on passenger profile",
            },
            {
              step: 4,
              action: "Add additional services",
              details:
                additional_services.length > 0
                  ? `Add services: ${additional_services.join(", ")}`
                  : "No additional services requested",
            },
            {
              step: 5,
              action: "Send confirmation",
              details: "Send booking confirmation and updated itinerary",
            },
          ],
          estimated_completion: "5-10 minutes",
          requires_agent_approval: selected_alternative.fare_difference > 500,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(workflow, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
        };
      }

    case "escalation_handoff":
      try {
        const {
          passenger_id,
          issue_complexity,
          conversation_history = [],
        } = args;

        let priority = "NORMAL";
        if (issue_complexity === "vip_handling") {
          priority = "HIGH";
        } else if (issue_complexity === "compensation_required") {
          priority = "MEDIUM";
        }

        let agentType = "Standard Agent";
        if (issue_complexity === "vip_handling") {
          agentType = "Senior VIP Agent";
        } else if (issue_complexity === "complex_itinerary") {
          agentType = "Specialist Agent";
        }

        const handoff = {
          escalation_id: `ESC_${Date.now()}`,
          passenger_id,
          issue_complexity,
          priority,
          context: {
            conversation_summary:
              conversation_history.length > 0
                ? `Customer has had ${conversation_history.length} previous interactions`
                : "First contact",
            recommended_agent_type: agentType,
            preparation_notes: [
              "Customer is already aware of delay",
              "Alternative options have been presented",
              "Customer preferences are documented in profile",
            ],
          },
          handoff_reason: getHandoffReason(issue_complexity),
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(handoff, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
        };
      }

    case "create_delay_notification":
      try {
        const {
          passenger_id,
          flight_number,
          delay_minutes,
          notification_type = "email",
          message_content,
        } = args;

        const notificationId = `NOTIFY_${Date.now()}`;
        const createdAt = new Date().toISOString();

        const notification = {
          NotificationId: notificationId,
          CreatedAt: createdAt,
          PassengerId: passenger_id,
          FlightNumber: flight_number,
          DelayMinutes: delay_minutes,
          NotificationType: notification_type,
          MessageContent: message_content,
          Status: "sent",
          DeliveredAt: createdAt,
        };

        await docClient.send(
          new PutCommand({
            TableName: DELAY_NOTIFICATIONS_TABLE,
            Item: notification,
          })
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  notification_id: notificationId,
                  status: "created",
                  passenger_id,
                  flight_number,
                  notification_type,
                  created_at: createdAt,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
        };
      }

    case "start_support_session":
      try {
        const {
          passenger_id,
          issue_type,
          initial_context = "",
          agent_id = "AI_ASSISTANT",
        } = args;

        const sessionId = `SESSION_${Date.now()}`;
        const createdAt = new Date().toISOString();

        const session = {
          SessionId: sessionId,
          CreatedAt: createdAt,
          PassengerId: passenger_id,
          AgentId: agent_id,
          IssueType: issue_type,
          InitialContext: initial_context,
          Status: "active",
          Messages: [],
          Resolution: null,
        };

        await docClient.send(
          new PutCommand({
            TableName: CUSTOMER_SUPPORT_SESSIONS_TABLE,
            Item: session,
          })
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id: sessionId,
                  status: "started",
                  passenger_id,
                  issue_type,
                  agent_id,
                  created_at: createdAt,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
        };
      }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
  }
});

function getHandoffReason(complexity) {
  switch (complexity) {
    case "vip_handling":
      return "VIP customer requires personalized attention and premium service";
    case "complex_itinerary":
      return "Multiple flights/complex routing requires specialist handling";
    case "compensation_required":
      return "Customer may be entitled to compensation - requires policy expertise";
    case "simple_rebooking":
      return "Standard rebooking that couldn't be completed automatically";
    default:
      return "General customer service assistance required";
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Airline Customer Service MCP Server running on stdio");
}

main().catch(console.error);
