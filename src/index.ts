function getTask(args: string[]): string {
  return args.join(" ").trim();
}

const task = getTask(process.argv.slice(2));

if (task === "") {
  console.error('Usage: npm start -- "your task"');
  process.exitCode = 1;
} else {
  console.log(`Task received: ${task}`);
}
