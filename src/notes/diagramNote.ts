import { yamlString } from './noteFormat';

export interface DiagramNote {
	repo: string;
	file: string;
	commit: string;
	symbol: string;
	/** What was drawn, e.g. `start in heron/src/server.ts`. */
	subject: string;
	model: string;
	/** `YYYY-MM-DD`. */
	date: string;
	mermaid: string;
	/** Links (or plain names, for files outside the vault) to the code the diagram draws on. */
	codeLinks: string[];
}

/** A note holding a model-drawn Mermaid diagram, with links back to the code. */
export function renderDiagramNote(d: DiagramNote): string {
	const lines = [
		'---',
		`repo: ${yamlString(d.repo)}`,
		`file: ${yamlString(d.file)}`,
		`commit: ${yamlString(d.commit)}`,
		...(d.symbol ? [`symbol: ${yamlString(d.symbol)}`] : []),
		'kind: diagram',
		'---',
		'',
		`# Diagram of ${d.subject}`,
		'',
		`Drawn by \`${d.model}\` on ${d.date} from the language server's outline, calls and references. Check it against the code.`,
		'',
		'```mermaid',
		d.mermaid,
		'```',
		'',
		'## Code',
		'',
		...d.codeLinks.map((link) => `- ${link}`),
		'',
	];
	return lines.join('\n');
}
