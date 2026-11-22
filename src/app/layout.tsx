import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { TopBar } from "@/components/chrome";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Schema Guard", template: "%s · Schema Guard" },
  description: "Detects an upcoming breaking data change, prepares the downstream repair, and proves dashboard numbers stay correct before it ships.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// Runs before first paint so a saved theme never flashes the other one.
const themeScript = `try{var t=localStorage.getItem("sg-theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <TopBar />
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
