type Message = {
  role: "user" | "assistant";
  content: string;
};

function getTask(args: string[]): string {
  return args.join(" ").trim();
}

async function getReply(messages: Message[]): Promise<string> {
  const task = messages[messages.length - 1].content;
  return `You asked me to: ${task}`;
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
