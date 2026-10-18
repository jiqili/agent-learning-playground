"use client";

import { useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY } from "./theme";

type Theme = "light" | "dark";

function subscribe(onChange: () => void) {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	return () => observer.disconnect();
}

function currentTheme(): Theme {
	return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function useTheme(): Theme | undefined {
	return useSyncExternalStore(subscribe, currentTheme, () => undefined);
}

export function ThemeToggle() {
	const theme = useTheme();
	const next: Theme = theme === "light" ? "dark" : "light";

	function toggle() {
		document.documentElement.dataset.theme = next;
		try {
			localStorage.setItem(THEME_STORAGE_KEY, next);
		} catch {
			// Storage may be unavailable (private mode); the theme still applies for this page.
		}
	}

	return (
		<button
			type="button"
			className="theme-toggle"
			onClick={toggle}
			aria-label={next === "light" ? "切换到亮色主题" : "切换到暗色主题"}
			title={next === "light" ? "切换到亮色主题" : "切换到暗色主题"}
		>
			{theme === undefined ? null : theme === "light" ? "☾" : "☀"}
		</button>
	);
}
