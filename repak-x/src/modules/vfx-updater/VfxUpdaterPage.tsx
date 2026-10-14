// VFX Updater - Main Page Component (for separate window)

import React, { useEffect } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import VfxUpdaterPanel from "./VfxUpdaterPanel";
import { VFX_WINDOW_WIDTH, VFX_WINDOW_HEIGHT } from "./types";
import "./VfxUpdater.css";
import TitleBar from "../../components/TitleBar";

// Resolves once the viewport has been resized (or after a timeout).
function waitForResize(timeoutMs = 300): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("resize", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    window.addEventListener("resize", done);
  });
}

// On Linux (GTK/Wayland) undecorated windows don't come out at the size they
// were created with, so re-apply it and fix up any remaining viewport offset.
async function correctLinuxWindowSize() {
  const win = getCurrentWindow();
  await win.setResizable(true);
  try {
    let width = VFX_WINDOW_WIDTH;
    let height = VFX_WINDOW_HEIGHT;
    for (let attempt = 0; attempt < 3; attempt++) {
      const offW = window.innerWidth - VFX_WINDOW_WIDTH;
      const offH = window.innerHeight - VFX_WINDOW_HEIGHT;
      if (Math.abs(offW) <= 1 && Math.abs(offH) <= 1) break;
      if (attempt > 0) {
        width -= offW;
        height -= offH;
      }
      await win.setSize(new LogicalSize(width, height));
      await waitForResize();
    }
  } finally {
    await win.setResizable(false);
  }
  await win.center();
}

export default function VfxUpdaterPage() {
  useEffect(() => {
    if (!navigator.userAgent.includes("Linux")) return;
    const frame = requestAnimationFrame(() => {
      correctLinuxWindowSize().catch((e) =>
        console.error("[VFX] Failed to correct window size:", e)
      );
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="vfx-window-container">
      <TitleBar title="Repak VFX Updater" hideMaximize={true} />
      <div className="vfx-updater-page">
        <VfxUpdaterPanel />
      </div>
    </div>
  );
}
