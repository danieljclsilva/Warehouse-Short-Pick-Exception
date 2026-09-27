import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Short Pick · Warehouse exceptions",
    short_name: "Short Pick",
    description: "Report and manage warehouse short-pick exceptions.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f8f6",
    theme_color: "#24765d",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
