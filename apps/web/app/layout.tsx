import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AuthProvider } from "./lib/auth-context";
import { PwaRegister } from "./components/pwa-register";

export const metadata: Metadata = {
  title: "OPC AI OS",
  description: "以今天的重点推进你的经营工作。",
  applicationName: "OPC AI OS"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="zh-CN"><body><AuthProvider><PwaRegister />{children}</AuthProvider></body></html>;
}
