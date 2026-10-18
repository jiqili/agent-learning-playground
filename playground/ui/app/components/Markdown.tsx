import type { ReactNode } from "react";

type Block =
	| { type: "p"; text: string }
	| { type: "ul"; items: string[] }
	| { type: "code"; lang: string; text: string };

function parse(source: string): Block[] {
	const blocks: Block[] = [];
	const lines = source.split(/\r?\n/);
	let paragraph: string[] = [];
	const flush = () => {
		if (paragraph.length) blocks.push({ type: "p", text: paragraph.join(" ") });
		paragraph = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("```")) {
			flush();
			const code: string[] = [];
			while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
			blocks.push({ type: "code", lang: line.slice(3).trim(), text: code.join("\n") });
		} else if (line.startsWith("- ")) {
			flush();
			const last = blocks.at(-1);
			if (last?.type === "ul") last.items.push(line.slice(2));
			else blocks.push({ type: "ul", items: [line.slice(2)] });
		} else if (!line.trim()) {
			flush();
		} else {
			paragraph.push(line.trim());
		}
	}
	flush();
	return blocks;
}

function inline(text: string): ReactNode[] {
	return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
		if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return <code key={index}>{part.slice(1, -1)}</code>;
		if (part.startsWith("**") && part.endsWith("**") && part.length > 3) return <strong key={index}>{part.slice(2, -2)}</strong>;
		return part;
	});
}

/** Renders the small markdown subset used by level descriptions (trusted, author-written content). */
export function Markdown({ source }: { source: string }) {
	return (
		<div className="markdown">
			{parse(source).map((block, index) => {
				if (block.type === "code") return <pre key={index}><code>{block.text}</code></pre>;
				if (block.type === "ul") return <ul key={index}>{block.items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>;
				return <p key={index}>{inline(block.text)}</p>;
			})}
		</div>
	);
}
