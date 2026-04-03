import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Catch Bad JSON (Multi-line) so the server doesn't crash
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error("Received malformed JSON from Cliq. Ignoring request.");
    return res.status(400).send({ text: "Webhook Error: Malformed JSON received." }); // Bad request
  }
  next();
});

const PORT = process.env.PORT || 3000;

// Initialize OpenAI for OpenRouter
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "http://localhost:3000",
    "X-Title": "Zoho Cliq Agent"
  }
});

let mcpClient = null;

async function initMcpClient() {
  const zUrl = process.env.ZOHO_MCP_URL === "https://your-zoho-mcp-url/api/sse"
    ? "https://birminghammcp-919432567.zohomcp.com/mcp/4fab1aeb4068ffad1e94c211febc52de/message"
    : (process.env.ZOHO_MCP_URL || "https://birminghammcp-919432567.zohomcp.com/mcp/4fab1aeb4068ffad1e94c211febc52de/message");

  if (!zUrl) {
    console.warn("URL not provided. MCP Tools will not be available.");
    return null;
  }

  // Set up Stdio transport with the custom Zoho MCP config
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mcp-remote", zUrl, "--transport", "http-only"]
  });

  const client = new Client({
    name: "zoho-cliq-webhook-agent",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  await client.connect(transport);
  return client;
}

const SYSTEM_PROMPT = `
Use zoho MCP connectors to access mcp and books through that to process and complete the task I will give you.
Do not ask confirmation, process the task directly.
And do not display the process you are doing such as giving the full invoice instruction before sending, just give a summary of the invoice sent once done.

Also, when you complete any tasks report to the birmingham channel, if failed as well.
"path_variables": { "CHANNEL_UNIQUE_NAME": "birmingham" }
Such as when you:
- create/list an invoice etc....

List of MCP Tools
1. Bigin
addNewUser, deleteUser, getModules, sendEmails, getSpecificUserData, getDeletedRecords, deleteRecords, createBulkRead, getRecords, updateRecords

2. Zoho Books
list purchase orders, update invoice, create estimate, bulk delete customer payments, create item, bulk export estimates as pdf, get invoice, submit estimate, get customer payment, list estimates, create invoice, approve invoice, update item, submit invoice, delete estimate, create sales receipt, cancel write off invoice, get estimate, delete purchase order, create purchase order, delete customer payment, update estimate, write off invoice, update sales receipt, email estimate, list sales receipts, delete invoice, list item details, list project invoices, delete item, approve estimate, delete sales receipt, get item, create customer payment, list customer payments, email invoice, list invoices, get sales receipt, get purchase order, update customer payment, list items, list contacts, create contact, get contact

3. Zoho Cliq
Post message in chat, Retrieve all direct chats, Create a channel, Add a record, Create and send a thread message, Trigger Bot Calls, Retrieve a message, Retrieve Bot Subscribers, Get Messages, Share files in a chat, Edit a message, Share files to a bot, Post message to a user, Share files to a user, Get main message of a thread, Post message in a channel, Post message to a bot, Get Files, Add a Bot to a Channel, Add a custom domain, Share files to a channel, List all channels

Organization ID in books: 918374864
in Zoho MCP: 91920733

----------------------------------------------------------------------------------------------------------------------
HOW TO CREATE AN INVOICE
----------------------------------------------------------------------------------------------------------------------
This is the process that model should follow for creation of invoice.
Remember to send the invoice to the customer via email. do not leave the invoice in draft.

1. ZohoBooks create invoice
Request Example:
{
  "body": {
    "customer_id": "8778022000000109065",
    "date": "2026-04-01",
    "due_date": "2026-04-22",
    "line_items": [
      {
        "item_id": "8778022000000129031",
        "name": "Clear Tempered Glass",
        "quantity": 5, "rate": 1200, "unit": "sqm",
        "tax_id": "8778022000000114093"
      }
    ],
    "notes": "Thank you for your business!"
  },
  "query_params": { "organization_id": "918374864", "send": true }
}

2. Next, send the invoice to customer
ZohoBooks email invoice
Request Example:
{
  "body": {
    "to_mail_ids": ["tiruvenmungah1@gmail.com"],
    "subject": "Invoice INV-000028",
    "body": "Dear Jane Doe,\n\nPlease find attached invoice INV-000028 for Clear Tempered Glass (x5 sqm) totalling MUR 6,900.00 (incl. 15% TVA). Payment is due by 22 April 2026.\n\nThank you for your business!",
    "send_from_org_email_id": false
  },
  "path_variables": { "invoice_id": "8778022000000262004" },
  "query_params": { "organization_id": "918374864", "send_attachment": true }
}

3. Next, send to channel
ZohoCliq Post message in a channel
Request Example:
{
  "body": {
    "text": "Invoice Created & Sent\n\n Invoice #: INV-000028\n Customer: Jane Doe (tiruvenmungah1@gmail.com)\n Item: Clear Tempered Glass — Qty: 5 sqm\n Total: MUR 6,900.00 (incl. 15% TVA)\n Due Date: 22 April 2026\n Invoice emailed to customer."
  },
  "path_variables": { "CHANNEL_UNIQUE_NAME": "birmingham" }
}

----------------------------------------------------------------------------------------------------------------------
HOW TO LIST INVOICES
----------------------------------------------------------------------------------------------------------------------
When finishing gathering data, post it in the channel.

1. Listing the invoices
ZohoBooks list invoices
Request Example:
{
  "query_params": {
    "date": "2026-03-31",
    "organization_id": "918374864"
  }
}

2. Next, post to channel
ZohoCliq Post message in a channel
Request Example:
{
  "body": {
    "text": " Invoice List Report — 31/03/2026\n\n Task completed: List all invoices on 31/03/2026\n\nCustomer: Jane Doe | tiruvenmungah1@gmail.com | INV-000019 | Sent | Due: 16/04/2026 | MUR 13,800.00\n...\n\n Total: 10 invoices | 3 Sent | 4 Draft | 3 Overdue | Grand Total: MUR 128,800.00"
  },
  "path_variables": { "CHANNEL_UNIQUE_NAME": "birmingham" }
}
`;

app.post('/webhook', async (req, res) => {
  try {
    const userMessage = req.body.text;
    if (!userMessage) {
      return res.status(400).json({ text: "No message provided." });
    }

    console.log("Received message from Cliq:", userMessage);

    // Initialize MCP Client on demand if not ready
    if (!mcpClient && process.env.ZOHO_MCP_URL) {
      console.log("Initializing MCP Client using npx mcp-remote...");
      mcpClient = await initMcpClient();
      console.log("MCP Client initialized.");
    }

    let mcpTools = [];
    let openAiTools = [];

    if (mcpClient) {
      try {
        const toolsResponse = await mcpClient.listTools();
        mcpTools = toolsResponse.tools || [];
        openAiTools = mcpTools.map(tool => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        }));
      } catch (err) {
        console.error("Failed to list MCP tools", err);
      }
    }

    const currentDate = new Date().toISOString().split('T')[0];
    const messages = [
      { role: "system", content: "Current Date: " + currentDate + "\n\n" + SYSTEM_PROMPT },
      { role: "user", content: userMessage }
    ];

    let finalResponseText = '';

    // Run agent tool loop
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      console.log(`Agent iteration ${iterations}...`);

      const runner = await openai.chat.completions.create({
        model: process.env.OPENROUTER_MODEL || "qwen/qwen-3.5-72b-instruct",
        messages: messages,
        tools: openAiTools.length > 0 ? openAiTools : undefined,
        tool_choice: "auto"
      });

      const choice = runner.choices[0];
      const message = choice.message;

      if (message.content) {
        messages.push({ role: "assistant", content: message.content });
        finalResponseText += message.content + "\n";
      } else if (message.tool_calls) {
        messages.push(message);
      } else {
        break;
      }

      if (!message.tool_calls || message.tool_calls.length === 0) {
        break; // No more tools
      }

      for (const toolCall of message.tool_calls) {
        console.log(`Executing tool: ${toolCall.function.name}`);
        try {
          const functionArgs = JSON.parse(toolCall.function.arguments);

          const result = await mcpClient.callTool({
            name: toolCall.function.name,
            arguments: functionArgs
          });

          let resultContent = "Success";
          if (result.content && result.content.length > 0) {
            resultContent = result.content.map(c => c.text).join("\n");
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: resultContent
          });
          console.log(`Tool ${toolCall.function.name} output: ${resultContent.substring(0, 50)}...`);
        } catch (err) {
          console.error("Error executing tool:", err);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: `Error executing tool: ${err.message}`
          });
        }
      }
    }

    res.json({
      text: finalResponseText.trim() || 'Task completed but the agent returned no text.'
    });

  } catch (error) {
    console.error("Webhook processing error:", error);
    res.status(500).json({ text: "An error occurred while processing your request: " + error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
