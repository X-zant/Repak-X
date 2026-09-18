// VFX Updater - Color Extraction Logic

import type { ColorParam } from "../../types";
import { paramMatchesFilter } from "../filter";
import { readParamId } from "../materialParams";

export function getColorPropertyNames(): string[] {
  return [
    "ColorAndOpacity",
    "SpecifiedColor",
    "BaseColor",
    "HighlightColor",
    "FontTopColor",
    "FontButtomColor",
    "VectorParameter",
    "ShadowColor",
    "ContentColor",
    "OutlineColor",
    "Color",
    "TextColor",
    "BackgroundColor",
    "Emissive",
    "ParameterValue",
  ];
}

function getSlateColorValueAndPath(
  currentObject: any,
  currentPath: (string | number)[]
): { value: any; path: (string | number)[] } | null {
  if (currentObject?.StructType !== "SlateColor" || !Array.isArray(currentObject?.Value)) {
    return null;
  }

  const specifiedColorIndex = currentObject.Value.findIndex(
    (entry: any) => entry?.Name === "SpecifiedColor" && entry?.StructType === "LinearColor"
  );

  if (specifiedColorIndex === -1) {
    return null;
  }

  const specifiedColor = currentObject.Value[specifiedColorIndex];
  const colorValue = specifiedColor?.Value?.[0]?.Value;

  if (!colorValue || typeof colorValue.R === "undefined") {
    return null;
  }

  return {
    value: colorValue,
    path: [...currentPath, "Value", specifiedColorIndex, "Value", 0, "Value"],
  };
}

export function findColorsRecursive(
  currentObject: any,
  currentPath: (string | number)[],
  fileName: string,
  parentName: string,
  allParams: ColorParam[],
  relativePath: string
): void {
  if (!currentObject || typeof currentObject !== "object") {
    return;
  }

  const colorNames = getColorPropertyNames();
  const isLinearColorProperty =
    colorNames.includes(currentObject.Name) &&
    currentObject.StructType === "LinearColor";
  const isSlateColorProperty =
    colorNames.includes(currentObject.Name) &&
    currentObject.StructType === "SlateColor";
  const colorValue = isLinearColorProperty ? currentObject?.Value?.[0]?.Value : undefined;
  const slateColorMatch = isSlateColorProperty
    ? getSlateColorValueAndPath(currentObject, currentPath)
    : null;
  const resolvedColorValue = slateColorMatch?.value ?? colorValue;
  const resolvedPath = slateColorMatch?.path ?? [...currentPath, "Value", 0, "Value"];

  if (
    (isLinearColorProperty || isSlateColorProperty) &&
    resolvedColorValue &&
    typeof resolvedColorValue.R !== "undefined"
  ) {
    const paramName = `${parentName} - ${currentObject.Name}`;

    if (!paramMatchesFilter(paramName)) {
      return;
    }

    const id = `${relativePath}-${parentName}-${currentObject.Name}-${allParams.length}`;

    const sanitizedRgba = {
      ...resolvedColorValue,
      R: parseFloat(resolvedColorValue.R) || 0,
      G: parseFloat(resolvedColorValue.G) || 0,
      B: parseFloat(resolvedColorValue.B) || 0,
      A: parseFloat(resolvedColorValue.A) || 0,
    };

    console.debug("[VFX] Extracted color param", {
      fileName,
      relativePath,
      parentName,
      propertyName: currentObject.Name,
      structType: currentObject.StructType,
      path: resolvedPath,
    });

    allParams.push({
      id,
      fileName,
      paramName,
      path: resolvedPath,
      rgba: sanitizedRgba,
      relativePath,
      anchor: { path: currentPath, name: currentObject.Name, structType: currentObject.StructType },
    });
  } else {
    if (Array.isArray(currentObject)) {
      currentObject.forEach((item: any, index: number) => {
        findColorsRecursive(item, [...currentPath, index], fileName, parentName, allParams, relativePath);
      });
    } else {
      for (const key in currentObject) {
        if (Object.prototype.hasOwnProperty.call(currentObject, key)) {
          findColorsRecursive(currentObject[key], [...currentPath, key], fileName, parentName, allParams, relativePath);
        }
      }
    }
  }
}

export function parseJsonAndExtractColors(
  json: any,
  fileName: string,
  relativePath: string,
  allParams: ColorParam[]
): void {
  // FORMAT TYPE 1: VFX Material File (original format)
  const exportData = json?.Exports?.[0]?.Data;
  const vectorParamsArray = Array.isArray(exportData)
    ? exportData.find((p: any) => p.Name === "VectorParameterValues")
    : undefined;
  if (vectorParamsArray && vectorParamsArray.Value) {
    vectorParamsArray.Value.forEach((param: any, paramIndex: number) => {
      const paramInfo = param?.Value?.find((p: any) => p.Name === "ParameterInfo");
      const paramName = paramInfo?.Value?.find((p: any) => p.Name === "Name")?.Value;

      if (paramName) {
        if (!paramMatchesFilter(paramName)) return;

        const paramValueObj = param?.Value?.find((p: any) => p.Name === "ParameterValue");
        const colorIndex = paramValueObj?.Value?.findIndex?.((p: any) => p.Name === "ParameterValue") ?? -1;
        const linearColor = colorIndex >= 0 ? paramValueObj.Value[colorIndex]?.Value : undefined;

        if (linearColor) {
          const id = `${relativePath}-${paramName}-${paramIndex}`;
          const path: (string | number)[] = [
            "Exports", 0, "Data",
            json.Exports[0].Data.findIndex((p: any) => p.Name === "VectorParameterValues"),
            "Value", paramIndex, "Value",
            param.Value.findIndex((p: any) => p.Name === "ParameterValue"),
            "Value", colorIndex, "Value",
          ];
          const paramId = readParamId(paramInfo);
          const materialParam = paramId ? { id: paramId, entry: param } : undefined;

          const sanitizedRgba = {
            ...linearColor,
            R: parseFloat(linearColor.R) || 0,
            G: parseFloat(linearColor.G) || 0,
            B: parseFloat(linearColor.B) || 0,
            A: parseFloat(linearColor.A) || 0,
          };

          console.debug("[VFX] Extracted VectorParameter color", { paramName, path, rgba: sanitizedRgba });
          allParams.push({ id, fileName, paramName, path, rgba: sanitizedRgba, relativePath, materialParam });
        }
      }
    });
  }
  // FORMAT TYPE 2: RichText blueprints support
  else if (
    json?.Exports?.[0]?.$type === "UAssetAPI.ExportTypes.DataTableExport, UAssetAPI" &&
    json.Exports[0].Table?.Data
  ) {
    const tableData = json.Exports[0].Table.Data;
    const tablePath: (string | number)[] = ["Exports", 0, "Table", "Data"];

    tableData.forEach((row: any, rowIndex: number) => {
      if (row.StructType === "RichTextStyleRow") {
        const styleName = row.Name;
        const rowPath: (string | number)[] = [...tablePath, rowIndex, "Value"];
        findColorsRecursive(row.Value, rowPath, fileName, styleName, allParams, relativePath);
      }
    });
  }
  // FORMAT TYPE 3: Generic Blueprint support
  else if (Array.isArray(json?.Exports)) {
    json.Exports.forEach((exportItem: any, exportIndex: number) => {
      if (Array.isArray(exportItem.Data)) {
        const parentName = exportItem.ObjectName || `Export_${exportIndex}`;
        const basePath: (string | number)[] = ["Exports", exportIndex, "Data"];
        findColorsRecursive(exportItem.Data, basePath, fileName, parentName, allParams, relativePath);
      }
    });
  }
}
