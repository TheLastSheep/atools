/** Parent rendering accepts raster data or the existing revocable package lease. */
export async function pluginFeatureIcon(value: string, resolvePackage: (path: string) => Promise<string>): Promise<string> {
  if (!value || value.length > 8192) return "";
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//") || /[\u0000-\u001f\u007f]/.test(value)) return "";
  try { return await resolvePackage(value); } catch { return ""; }
}
