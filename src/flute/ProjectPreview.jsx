"use client";
import React from "react";
import { ProjectPreview } from "@webprodigies/flute/preview";
import { sceneModules } from "./catalog";
// Host-owned development flag: no process, Vite or Electron globals in this adapter.
export function FluteProjectPreview({ children, enabled, active, ...props }) {
  if (!enabled) return children;
  return <ProjectPreview {...props} projectId="437e2ac5-7da0-4607-a43b-9c96fa1f9fd3" enabled={enabled} active={active} sceneModules={sceneModules}>{children}</ProjectPreview>;
}
