import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { getCurrentUser } from "@/lib/auth";
import { InlineScript } from "./components/InlineScript";
import { LogoutButton } from "./components/LogoutButton";
import { ThemeToggle } from "./components/ThemeToggle";
import { themeBootstrap } from "./components/theme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Agent Learning Playground",
  description: "通过闯关学习如何从零实现 AI Agent",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Applies the saved/system theme before first paint to avoid a flash of the wrong theme. */}
        <InlineScript html={themeBootstrap} />
      </head>
      <body>
        <header className="site-header">
          <Link href="/" className="brand">Agent Learning Playground</Link>
          <div className="header-right">
            <Suspense fallback={null}>
              <HeaderUser />
            </Suspense>
            <ThemeToggle />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}

async function HeaderUser() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <nav className="header-user">
        <Link href="/login">登录</Link>
        <Link href="/register">注册</Link>
      </nav>
    );
  }
  return (
    <nav className="header-user">
      <Link href="/chapters">章节</Link>
      {user.isAdmin && <Link href="/admin">管理</Link>}
      <span>{user.username}</span>
      <LogoutButton />
    </nav>
  );
}
