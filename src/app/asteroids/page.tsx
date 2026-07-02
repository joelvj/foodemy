import type { Metadata, Viewport } from "next";
import AsteroidsGame from "./AsteroidsGame";

export const metadata: Metadata = {
  title: "Asteroids",
  description: "Classic Asteroids arcade game, playable in the browser on desktop and mobile.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#000000",
};

export default function AsteroidsPage() {
  return <AsteroidsGame />;
}
