import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OPC AI OS",
    short_name: "OPC AI OS",
    description: "以今天的重点推进你的经营工作。",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#f6f8f4",
    theme_color: "#385b45",
    lang: "zh-CN",
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }
    ]
  };
}
