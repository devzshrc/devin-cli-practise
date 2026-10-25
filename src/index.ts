// A conversation is an array of messages matching this shape.
type Message = {
  role: "user" | "assistant";
  content: string;
};

const apiKey = process.env.DEEPSEEK_API_KEY;
console.log("API key loaded:", Boolean(apiKey));

function getTask(args: string[]): string {
  return args.join(" ").trim();
}

async function getReply(messages: Message[]): Promise<string> {
  const model = process.env.DEEPSEEK_MODEL;
  if (!apiKey || !model) {
    throw new Error("Set DEEPSEEK_API_KEY and DEEPSEEK_MODEL in .env");
  }

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      // Send the supplied conversation instead of rebuilding a single message.
      messages: messages,
      max_tokens: 512,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  // response belongs to this function, so inspect it before the closing brace.
  if (!response.ok) {
    throw new Error(`DeepSeek request failed: ${response.status}`);
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content;

  if (typeof reply !== "string" || reply.trim() === "") {
    throw new Error("DeepSeek returned no reply text");
  }

  // Return the text so the caller can add it to the conversation.
  return reply;
}

async function main(): Promise<void> {
  if (!apiKey || !process.env.DEEPSEEK_MODEL) {
    throw new Error("Set DEEPSEEK_API_KEY and DEEPSEEK_MODEL in .env");
  }

  // Create history once, outside the loop, so earlier messages survive each turn.
  const messages: Message[] = [];
  const terminal = createInterface({ input: stdin, output: stdout });
  // The iterator queues input, including lines typed while the API is working.
  const input = terminal[Symbol.asyncIterator]();
  let task = getTask(process.argv.slice(2));

  console.log(
    'Chat started. Type "exit" to quit. History lasts for this session.',
  );

  try {
    while (true) {
      // Use the command-line task first, or wait for a line from the terminal.
      if (task === "") {
        stdout.write("You: ");
        const next = await input.next();
        if (next.done) break; // Ctrl+D / end of input closes the session.
        task = next.value.trim();
      }

      if (task.toLowerCase() === "exit") break;
      if (task === "") continue; // Empty input does not make an API request.

      messages.push({ role: "user", content: task });

      try {
        const reply = await getReply(messages);
        messages.push({ role: "assistant", content: reply });
        console.log(`Assistant: ${reply}`);
      } catch (error) {
        // Remove the failed turn so the user can retry without duplicating it.
        messages.pop();
        console.error(error instanceof Error ? error.message : String(error));
      }

      // Reset the task so the next iteration waits for new input.
      task = "";
    }
  } finally {
    // Release the input stream even if the loop throws an error.
    terminal.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

// TRY IT:
// npm start -- "My name is Devashish" -> sends the first message, then prompts
// Type: What is my name?             -> sends previous messages too
// Type: exit                         -> closes the session
// npm start                          -> opens the prompt without an initial task
// npm run typecheck                  -> checks TypeScript types
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { readFile } from "node:fs/promises";
