import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "OPC AI OS",
  description: "V1-A project scaffold"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
