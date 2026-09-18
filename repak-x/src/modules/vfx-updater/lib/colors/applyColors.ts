// VFX Updater - Color Application Logic

import type { ColorAnchor, ColorParam } from "../../types";
import { portMaterialParam } from "../materialParams";

export function setNestedValue(
  obj: any,
  path: (string | number)[],
  value: Record<string, number>
): boolean {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current === undefined || current === null) {
      console.debug("[VFX] setNestedValue: path traversal failed at index", i, "path:", path);
      return false;
    }
    current = current[path[i]];
  }
  if (current === undefined || current === null) {
    console.debug("[VFX] setNestedValue: final parent is null/undefined, path:", path);
    return false;
  }
  const lastKey = path[path.length - 1];
  if (typeof current[lastKey] === "object" && typeof value === "object") {
    Object.assign(current[lastKey], value);
  } else {
    current[lastKey] = value;
  }
  console.debug("[VFX] setNestedValue: successfully set value at path", path);
  return true;
}

function getNestedValue(obj: any, path: (string | number)[]): any {
  let current = obj;
  for (const key of path) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }
  return current;
}

function anchorMatches(json: any, anchor: ColorAnchor): boolean {
  const node = getNestedValue(json, anchor.path);
  return node?.Name === anchor.name && node?.StructType === anchor.structType;
}

export function applyColorToJson(
  json: any,
  color: ColorParam
): boolean {
  console.debug("[VFX] Applying color to JSON", {
    paramName: color.paramName,
    path: color.path,
    rgba: color.rgba,
  });

  // Material vector parameters are ported as the mod's whole entry, matched by identity.
  if (color.materialParam) {
    return portMaterialParam(json, "VectorParameterValues", color.materialParam) !== "missing";
  }

  const path = color.path;
  if (color.anchor && !anchorMatches(json, color.anchor)) {
    // The same position holds a different property in the target; writing would corrupt it.
    return false;
  }

  const target = getNestedValue(json, path);
  if (!target || typeof target !== "object" || typeof target.R === "undefined") {
    return false;
  }

  return setNestedValue(json, path, {
    R: color.rgba.R,
    G: color.rgba.G,
    B: color.rgba.B,
    A: color.rgba.A,
  });
}
