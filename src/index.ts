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

const task = getTask(process.argv.slice(2));

if (task === "") {
  console.error('Usage: npm start -- "your task"');
  process.exitCode = 1;
} else {
  const messages: Message[] = [{ role: "user", content: task }];
  const reply = await getReply(messages);
  messages.push({ role: "assistant", content: reply });
  console.log(messages);
}
