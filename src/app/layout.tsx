import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Footage — Find the moment",
  description: "A local video search workspace. Baseline prototype.",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
