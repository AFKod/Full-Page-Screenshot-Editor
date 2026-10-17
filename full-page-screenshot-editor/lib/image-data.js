// Decode locally without fetch(): strict extension CSP intentionally blocks network/data fetches.
export function pngDataURLToBlob(dataURL) {
  const prefix = "data:image/png;base64,";
  if (typeof dataURL !== "string" || !dataURL.startsWith(prefix)) throw new Error("Chrome вернул некорректный PNG-кадр.");
  const binary = atob(dataURL.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}
