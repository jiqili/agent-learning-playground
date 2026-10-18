"use client";

import { javascript } from "@codemirror/lang-javascript";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import type { KeyboardEvent } from "react";
import { useTheme } from "./ThemeToggle";

interface CodeEditorProps {
	value: string;
	onChange: (value: string) => void;
	onRun: () => void;
}

const extensions = [
	javascript({ typescript: true }),
	EditorView.theme({
		"&": { height: "100%", fontSize: "13px" },
		".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
		".cm-gutters": { borderRight: "none" },
	}),
];

export function CodeEditor({ value, onChange, onRun }: CodeEditorProps) {
	const theme = useTheme();

	// Capture phase runs before CodeMirror's own Mod-Enter binding (insert blank line).
	function onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
		if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			onRun();
		}
	}

	return (
		<div className="code-editor" onKeyDownCapture={onKeyDownCapture}>
			<CodeMirror
				value={value}
				onChange={onChange}
				extensions={extensions}
				theme={theme === "light" ? githubLight : githubDark}
				height="100%"
				style={{ height: "100%" }}
				basicSetup={{ tabSize: 4 }}
				aria-label="代码编辑器"
			/>
		</div>
	);
}
