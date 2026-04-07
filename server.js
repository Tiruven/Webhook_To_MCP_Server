// ============================================================
// Birmingham Glass Solutions Ltd — Zoho Cliq Bot Webhook
// Stack: Node.js + Express + OpenRouter (via OpenAI SDK) + Zoho MCP
// ============================================================

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.text()); // Fallback for non-JSON Cliq payloads

// Catch malformed JSON from Cliq so the server doesn't crash
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('Received malformed JSON from Cliq. Ignoring request.');
    return res.status(400).json({ text: 'Webhook Error: Malformed JSON received.' });
  }
  next();
});

const PORT = process.env.PORT || 3000;

// ============================================================
// OpenAI-compatible client pointed at OpenRouter
// ============================================================
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'http://localhost:3000',
    'X-Title': 'Birmingham Glass Cliq Agent'
  }
});

// ============================================================
// MODEL FALLBACK CHAIN — tries each model in order on rate limit
// ============================================================
const MODELS = [
  'openai/gpt-oss-120b:free', // Strong reasoning
  'qwen/qwen3.6-plus:free', // best model | rate limited
  'nvidia/nemotron-3-super-120b-a12b:free',
  'stepfun/step-3.5-flash:free',
  'qwen/qwen3-next-80b-a3b-instruct:free', // Best tool-use
  'nvidia/nemotron-3-nano-30b-a3b:free', // fast 
  'arcee-ai/trinity-large-preview:free'
];

//'openai/gpt-oss-120b:free', // Strong reasoning
//'qwen/qwen3.6-plus:free', // best model | rate limited
//'nvidia/nemotron-3-super-120b-a12b:free'
//'qwen/qwen3-next-80b-a3b-instruct:free', // Best tool-use
//'nvidia/nemotron-3-nano-30b-a3b:free', // fast 
//'arcee-ai/trinity-large-preview:free',


// Returns true if the error should cause a switch to the next model
function isSwitchableError(err) {
  const isRateLimit =
    err.status === 429 ||
    err.message?.toLowerCase().includes('rate') ||
    err.message?.toLowerCase().includes('quota');
  const isNoToolSupport =
    err.status === 404 &&
    err.message?.toLowerCase().includes('tool');
  return isRateLimit || isNoToolSupport;
}

// ============================================================
// CONVERSATION STORE — in-memory chat history per user
// ============================================================
const conversationStore = {};
const MAX_HISTORY = 10; // keep last 10 user+assistant exchanges

function getHistory(userId) {
  if (!conversationStore[userId]) conversationStore[userId] = [];
  return conversationStore[userId];
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  // Trim to MAX_HISTORY messages
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ============================================================
// MCP CLIENT — Authorization via Connection
// No auth headers needed — Zoho MCP portal handles auth server-side
// ============================================================
let mcpClient = null;

async function initMcpClient() {
  const mcpUrl = process.env.ZOHO_MCP_URL;
  if (!mcpUrl) {
    console.warn('ZOHO_MCP_URL not set. MCP tools will not be available.');
    return null;
  }

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'mcp-remote', mcpUrl, '--transport', 'http-only']
  });

  const client = new Client(
    { name: 'birmingham-glass-cliq-agent', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('MCP Client connected successfully.');
  return client;
}

// ============================================================
// SYSTEM PROMPT
// ============================================================
const SYSTEM_PROMPT = `
You are a Zoho Books assistant for Birmingham Glass Solutions Ltd.
Use Zoho MCP tools to complete tasks directly. Do not ask for confirmation.
Do not narrate your process. Just complete the task and post a concise summary to the birmingham Cliq channel when done.

Also, when you complete any tasks report to the birmingham channel, if failed as well.
"path_variables": { "CHANNEL_UNIQUE_NAME": "birmingham" }

List of MCP Tools
1. Bigin
addNewUser, deleteUser, getModules, sendEmails, getSpecificUserData, getDeletedRecords, deleteRecords, createBulkRead, getRecords, updateRecords

2. Zoho Books
list purchase orders, update invoice, create estimate, bulk delete customer payments, create item, bulk export estimates as pdf, get invoice, submit estimate, get customer payment, list estimates, create invoice, approve invoice, update item, submit invoice, delete estimate, create sales receipt, cancel write off invoice, get estimate, delete purchase order, create purchase order, delete customer payment, update estimate, write off invoice, update sales receipt, email estimate, list sales receipts, delete invoice, list item details, list project invoices, delete item, approve estimate, delete sales receipt, get item, create customer payment, list customer payments, email invoice, list invoices, get sales receipt, get purchase order, update customer payment, list items, list contacts, create contact, get contact

3. Zoho Cliq
Post message in chat, Retrieve all direct chats, Create a channel, Add a record, Create and send a thread message, Trigger Bot Calls, Retrieve a message, Retrieve Bot Subscribers, Get Messages, Share files in a chat, Edit a message, Share files to a bot, Post message to a user, Share files to a user, Get main message of a thread, Post message in a channel, Post message to a bot, Get Files, Add a Bot to a Channel, Add a custom domain, Share files to a channel, List all channels

Organization ID in books: 918374864
in Zoho MCP: 91920733

======================================================================
HOW TO CREATE AN INVOICE
======================================================================
This is the process that model should follow for creation of invoice.
Remember to send the invoice to the customer via email. do not leave the invoice in draft.

STEP 1 — Create the invoice:
Tool: ZohoBooks_create_invoice
{
  "body": {
    "customer_id": "8778022000000109065",
    "date": "<today>",
    "due_date": "<21 days from today>",
    "line_items": [
      {
        "item_id": "8778022000000129031",
        "name": "Clear Tempered Glass",
        "quantity": <qty>,
        "rate": 1200,
        "unit": "sqm",
        "tax_id": "8778022000000114093"
      }
    ],
    "notes": "Thank you for your business!"
  },
  "query_params": { "organization_id": "918374864", "send": true }
}

STEP 2 — Email the invoice to the customer:
Tool: ZohoBooks_email_invoice
{
  "body": {
    "to_mail_ids": ["<customer email>"],
    "subject": "Invoice <INV-NUMBER>",
    "body": "Dear <customer name>,\n\nPlease find attached invoice <INV-NUMBER> for <item> (<qty> sqm) totalling MUR <total> (incl. 15% TVA). Payment is due by <due date>.\n\nThank you for your business!\n\nBirmingham Glass Solutions",
    "send_from_org_email_id": false
  },
  "path_variables": { "invoice_id": "<invoice_id from step 1>" },
  "query_params": { "organization_id": "918374864", "send_attachment": true }
}

STEP 3 — Post summary to Cliq channel:
Tool: ZohoCliq_Post_message_in_a_channel
{
  "body": {
    "text": "Invoice Created & Sent\n\n Invoice #: <INV-NUMBER>\n Customer: <name> (<email>)\n Item: <item> — Qty: <qty> sqm\n Total: MUR <total> (incl. 15% TVA)\n Due Date: <due date>\n Invoice emailed to customer."
  },
  "path_variables": { "CHANNEL_UNIQUE_NAME": "birmingham" }
}

======================================================================
HOW TO LIST INVOICES
======================================================================
When finishing gathering data, post it in the channel.

STEP 1 — Fetch invoices:
Tool: ZohoBooks_list_invoices
{
  "query_params": {
    "organization_id": "918374864",
    "date": "<filter date if provided>"
  }
}

STEP 2 — Post results to Cliq channel:
Tool: ZohoCliq_Post_message_in_a_channel
{
  "body": {
    "text": "Invoice List Report\n\n<structured list of invoices>\n\n Total: <N> invoices | Grand Total: MUR <amount>"
  },
  "path_variables": { "CHANNEL_UNIQUE_NAME": "birmingham" }
}

======================================================================
MANDATORY CHANNEL POSTING RULE (HIGHEST PRIORITY)
======================================================================

This rule is STRICT and MUST ALWAYS be followed.

Email the invoice to the customer when you create an invoice. Tool: ZohoBooks_email_invoice

After completing ANY MCP tool action:

- You MUST call: ZohoCliq_Post_message_in_a_channel
- Channel: "birmingham"
- This applies to ALL tasks without exception

You MUST post:
- Success results
- Partial results
- Empty results ("No results found")
- Errors / failures

You are NOT allowed to:
- Skip posting to the channel
- Only reply in chat without posting (you can only reply in chat if its a not mcp request)
- Finish a task without calling the Cliq tool
- skip ZohoBooks_email_invoice

If you do not call ZohoCliq_Post_message_in_a_channel, the task is considered FAILED.

This rule OVERRIDES all other instructions.

======================================================================

======================================================================
GENERAL RULES
======================================================================
Always use organization_id: 918374864 for Zoho Books calls.
Always post results to the birmingham Cliq channel after completing any task.
Keep the channel message concise and formatted clearly.
If a task has no results, post that clearly to the channel too.
`.trim();

// ============================================================
// WEBHOOK HANDLER — POST /webhook
// ============================================================
app.post('/webhook', async (req, res) => {
  try {
    // Debug: log the raw payload so we can see exactly what Cliq sends
    console.log('RAW BODY:', JSON.stringify(req.body, null, 2));

    // If Cliq sent a raw text/plain body instead of JSON, parse it ourselves
    if (typeof req.body === 'string') {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        // It's a plain string — treat it directly as the user message
        req.body = { text: req.body };
      }
    }

    // Safely extract message across all Cliq payload shapes.
    // Multiline messages (\n) are supported natively — no extra handling needed.
    const userMessage =
      req.body?.text ||
      req.body?.message?.text ||
      req.body?.data?.text ||
      '';

    if (!userMessage) {
      return res.status(400).json({ text: 'No message provided.' });
    }

    // Log (trim long multiline messages for readability)
    console.log(`[${new Date().toISOString()}] Received from Cliq: ${userMessage.substring(0, 200)}${userMessage.length > 200 ? '...' : ''}`);

    // Lazy-init MCP client on first request
    if (!mcpClient && process.env.ZOHO_MCP_URL) {
      console.log('Initializing MCP Client...');
      mcpClient = await initMcpClient();
    }

    // Fetch available tools from MCP and convert to OpenAI tool format
    let openAiTools = [];
    if (mcpClient) {
      try {
        const { tools: mcpTools } = await mcpClient.listTools();
        openAiTools = (mcpTools || []).map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        }));
        console.log(`Loaded ${openAiTools.length} MCP tools.`);
      } catch (err) {
        console.error('Failed to list MCP tools:', err.message);
      }
    }

    // Identify user for conversation memory (use sender email/id if available, fallback to 'default')
    const userId =
      req.body?.user_id ||
      req.body?.sender?.email ||
      req.body?.message?.sender?.email ||
      'default';

    const currentDate = new Date().toISOString().split('T')[0];

    // Build message history: system prompt + past conversation + current message
    const history = getHistory(userId);
    const messages = [
      { role: 'system', content: `Current Date: ${currentDate}\n\n${SYSTEM_PROMPT}` },
      ...history,
      { role: 'user', content: userMessage }
    ];

    console.log(`[Memory] User: ${userId} | History length: ${history.length}`);

    let finalResponseText = '';
    const MAX_ITERATIONS = 8;

    // Pick starting model — sticks for the whole request, only switches on error
    let modelIndex = 0;
    let currentModel = MODELS[modelIndex];
    console.log(`[Model] Selected: ${currentModel}`);

    // ============================================================
    // AGENTIC TOOL LOOP
    // Same model is reused every iteration. Switches only on error.
    // ============================================================
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      console.log(`Agent iteration ${i + 1} | Model: ${currentModel}`);

      let completion;
      try {
        completion = await openai.chat.completions.create({
          model: currentModel,
          messages,
          tools: openAiTools.length > 0 ? openAiTools : undefined,
          tool_choice: 'auto'
        });
      } catch (err) {
        if (isSwitchableError(err)) {
          modelIndex++;
          if (modelIndex >= MODELS.length) throw err; // All models exhausted
          currentModel = MODELS[modelIndex];
          console.warn(`[Model] Switching to: ${currentModel} (${err.message})`);
          i--; // Retry this iteration with the new model
          continue;
        }
        throw err;
      }

      const choice = completion.choices[0];
      const message = choice.message;

      // Collect any text the model produces
      if (message.content) {
        finalResponseText += message.content + '\n';
      }

      // If no tool calls, the model is done
      if (!message.tool_calls || message.tool_calls.length === 0) {
        messages.push({ role: 'assistant', content: message.content || '' });
        break;
      }

      // Push the assistant's tool-call message into history
      messages.push(message);

      // Execute each tool call and push results back
      for (const toolCall of message.tool_calls) {
        console.log(`Executing tool: ${toolCall.function.name}`);
        let resultContent = 'Tool executed.';

        try {
          const args = JSON.parse(toolCall.function.arguments);
          const result = await mcpClient.callTool({
            name: toolCall.function.name,
            arguments: args
          });

          if (result.content && result.content.length > 0) {
            resultContent = result.content.map(c => c.text).join('\n');
          }
          console.log(`Tool result preview: ${resultContent.substring(0, 80)}...`);
        } catch (err) {
          console.error(`Tool ${toolCall.function.name} error:`, err.message);
          resultContent = `Error executing tool: ${err.message}`;
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: resultContent
        });
      }
    }

    const responseText = finalResponseText.trim() || 'Task completed.';
    console.log(`[${new Date().toISOString()}] Agent done. Response: ${responseText.substring(0, 100)}...`);

    // Save this exchange to conversation memory
    addToHistory(userId, 'user', userMessage);
    addToHistory(userId, 'assistant', responseText);

    res.json({ text: responseText });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({
      text: 'Something went wrong on my end. Please try again.'
    });
  }
});

// ============================================================
// HEALTH CHECK — GET /
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Birmingham Glass Solutions — Cliq Bot',
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`
  ================================================
   Birmingham Glass Solutions — Cliq Bot Webhook
  ================================================
   Server running on port ${PORT}
   Webhook endpoint: POST /webhook
   Health check   : GET  /
  ================================================
  `);
});
