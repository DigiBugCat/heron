// Stands in for `claude -p --output-format json` in tests: echoes its
// arguments and stdin back in the CLI's JSON shape.
let input = '';
const args = process.argv.slice(2);
if (args.includes('--hang')) setInterval(() => {}, 1000);
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
	if (args.includes('--hang')) return;
	if (args.includes('--fail')) {
		process.stderr.write('fake-claude: not logged in\n');
		process.exit(1);
	}
	process.stderr.write('[warning] something on stderr\n');
	const model = args[args.indexOf('--model') + 1];
	const system = args[args.indexOf('--system-prompt') + 1];
	const tools = args[args.indexOf('--tools') + 1];
	process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `${model}|${system}|tools=${tools}|${input}` }));
});
