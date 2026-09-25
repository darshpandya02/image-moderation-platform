import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Image Moderation Platform",
  description:
    "Upload an image; it is stored, queued, classified by an open-source NSFW model, and approved, rejected or sent to human review by a configurable policy.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            Image Moderation
          </Link>
          <nav>
            <Link href="/">Upload &amp; gallery</Link>
            <Link href="/policies">Policies</Link>
            <Link href="/review">Reviewer</Link>
            <a href="https://github.com/darshpandya02/image-moderation-platform">Source</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          Uploads are public demo content. Only images that pass moderation appear in the gallery.
        </footer>
      </body>
    </html>
  );
}
