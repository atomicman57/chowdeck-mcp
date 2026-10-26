import { Buffer } from "node:buffer";
import * as api from "./api.js";
const IMAGE_HOSTS = new Set(["files.chowdeck.com", "files.chowdeck.studio", "res.cloudinary.com", "menu-images-production.s3.amazonaws.com"]);
export function imageUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, "https://files.chowdeck.com/");
    if (url.protocol !== "https:" || url.username || url.password || url.port || !IMAGE_HOSTS.has(url.hostname)) return null;
    if(url.hostname==='files.chowdeck.com' && url.pathname.startsWith('/eyJ')) {
      try {const decoded=JSON.parse(Buffer.from(decodeURIComponent(url.pathname.slice(1)), 'base64').toString());
        if(decoded.bucket==='menu-images-production'&&typeof decoded.key==='string'&&/^[a-zA-Z0-9_./-]+\.(?:jpe?g|png|webp)$/i.test(decoded.key)&&!decoded.key.split('/').includes('..'))return 'https://menu-images-production.s3.amazonaws.com/'+decoded.key.split('/').map(encodeURIComponent).join('/');
      }catch{}
    }
    return url.toString();
  } catch { return null; }
}
export async function foodPhotos(vendorId: number, menuId?: number, query?: string, limit = 2) {
  const raw = menuId ? await api.getMenuItem(vendorId, menuId) : await api.getMenu(vendorId);
  const candidates: any[] = [];
  const seen = new Set<string>();
  function visit(value: any, depth = 0) {
    if (!value || depth > 14) return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1);return; }
    if (typeof value !== "object") return;
    const name = value.name ?? value.title;
    if (typeof name === "string" && value.id !== undefined && (!query || name.toLowerCase().includes(query.toLowerCase()))) {
      const sources = [...(Array.isArray(value.images) ? value.images : []), ...(Array.isArray(value.photos) ? value.photos : []), value.image, value.image_url, value.photo];
      const urls = [...new Set(sources.map((entry: any) => imageUrl(typeof entry === "string" ? entry : entry?.path ?? entry?.url ?? entry?.image_url)).filter(Boolean))];
      if (urls.length && !seen.has(String(value.id))) { seen.add(String(value.id));candidates.push({ vendor_id: vendorId, menu_id: value.id, name, price_kobo: value.price ?? value.price_per_quantity, in_stock: value.in_stock, image_urls: urls.slice(-3) }); }
    }
    for (const [field, child] of Object.entries(value)) if (child && typeof child === "object" && !["vendor", "category", "images", "photos"].includes(field)) visit(child, depth + 1);
  }
  visit(raw?.data ?? raw);
  return { source: "Chowdeck menu photography", generated: false, vendor_id: vendorId, items: candidates.slice(0, limit), message: candidates.length ? "Photos identify the listed food item; presentation may vary. No cart or order was changed." : "No supported menu photos were found for this selection." };
}
/** Fetch only known public image CDNs. Never send the account Authorization header. */
export async function downloadFoodImage(rawUrl: string, fetcher: typeof fetch = fetch) {
  let url: string | null = imageUrl(rawUrl);
  if (!url) throw new Error("Unsupported image host or URL.");
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response: Response = await fetcher(url, { redirect: "manual", headers: { accept: "image/jpeg,image/png,image/webp", "user-agent": "ChowdeckPersonalMCP-Images/0.7" }, signal: AbortSignal.timeout(15000), cache: "no-store" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const destination: string | null = response.headers.get("location");
      url = destination ? imageUrl(new URL(destination, url).toString()) : null;
      if (!url) throw new Error("Image redirected to an unsupported host.");
      continue;
    }
    if (!response.ok) throw new Error("Food image could not be retrieved.");
    const mime = (response.headers.get("content-type") ?? "").split(";")[0];
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new Error("The response was not a supported food image.");
    const maxBytes = 2 * 1024 * 1024;
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error("Image is too large to embed; use its source link.");
    const reader = response.body?.getReader();if (!reader) throw new Error("Image body is missing.");
    const chunks: Uint8Array[] = [];let size = 0;
    while (true) {
      const { done, value } = await reader.read();if (done) break;
      size += value.length;if (size > maxBytes) { await reader.cancel();throw new Error("Image is too large to embed; use its source link."); }
      chunks.push(value);
    }
    return { type: "image" as const, mimeType: mime, data: Buffer.concat(chunks).toString("base64") };
  }
  throw new Error("Image redirected too many times.");
}
