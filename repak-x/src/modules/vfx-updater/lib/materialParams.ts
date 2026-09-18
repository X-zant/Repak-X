// VFX Updater - Material instance parameter porting

import type { MaterialParam, MaterialParamId } from "../types";

export type MaterialParamList = "ScalarParameterValues" | "VectorParameterValues";

/** Name, association and layer index of a material ParameterInfo struct. */
export function readParamId(paramInfo: any): MaterialParamId | undefined {
  const fields: any[] = Array.isArray(paramInfo?.Value) ? paramInfo.Value : [];
  const name = fields.find((p) => p?.Name === "Name")?.Value;
  if (typeof name !== "string") return undefined;
  const association = fields.find((p) => p?.Name === "Association")?.Value;
  const index = fields.find((p) => p?.Name === "Index")?.Value;
  return {
    name,
    association: typeof association === "string" ? association : undefined,
    index: typeof index === "number" ? index : undefined,
  };
}

export function entryParamId(entry: any): MaterialParamId | undefined {
  const fields = entry?.Value;
  if (!Array.isArray(fields)) return undefined;
  return readParamId(fields.find((p: any) => p?.Name === "ParameterInfo"));
}

// Unversioned properties drop zero-valued fields, so a missing field means the default.
function sameParamId(a: MaterialParamId, b: MaterialParamId): boolean {
  return (
    a.name === b.name &&
    (a.association ?? "GlobalParameter") === (b.association ?? "GlobalParameter") &&
    (a.index ?? -1) === (b.index ?? -1)
  );
}

function paramList(json: any, list: MaterialParamList): any[] | null {
  const data = json?.Exports?.[0]?.Data;
  if (!Array.isArray(data)) return null;
  const values = data.find((p: any) => p?.Name === list)?.Value;
  return Array.isArray(values) ? values : null;
}

/** Every parameter entry of `list` in a material instance JSON. */
export function readMaterialParams(json: any, list: MaterialParamList): MaterialParam[] {
  const params: MaterialParam[] = [];
  for (const entry of paramList(json, list) ?? []) {
    const id = entryParamId(entry);
    if (id) params.push({ id, entry });
  }
  return params;
}

export type PortResult = "changed" | "unchanged" | "missing";

/**
 * Replace the target's entry for `param` with the mod's whole entry. Copying the entry, not
 * just its value, keeps its unversioned struct header in step with which fields are zero —
 * UAssetAPI writes that header verbatim, so flipping a value to or from zero in place would
 * either be dropped or desync the stream.
 */
export function portMaterialParam(json: any, list: MaterialParamList, param: MaterialParam): PortResult {
  const values = paramList(json, list);
  if (!values) return "missing";

  const index = values.findIndex((entry) => {
    const id = entryParamId(entry);
    return id !== undefined && sameParamId(id, param.id);
  });
  if (index < 0) return "missing";

  // The entry's own Name is its array slot, which is the target's, not the mod's.
  const replacement = { ...JSON.parse(JSON.stringify(param.entry)), Name: values[index].Name };
  if (JSON.stringify(values[index]) === JSON.stringify(replacement)) return "unchanged";

  values[index] = replacement;
  return "changed";
}
