import type {ChatProfile} from "../shared/profile-types";
import {escapeHtml} from "./html";

export function avatarPlaceholder(profile: ChatProfile) {
  const source = String(profile.name || profile.username || "U").trim() || "U";
  const parts = source.split(/\s+/).filter(Boolean);
  const initials = (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)![0]}` : [...source].slice(0, 2).join("")).toUpperCase();
  let hash = 0;
  for (const character of String(profile.username || profile.name || initials)) hash = ((hash << 5) - hash + character.codePointAt(0)!) | 0;
  const hue = Math.abs(hash) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="32" fill="hsl(${hue} 58% 48%)"/><text x="128" y="145" text-anchor="middle" font-family="system-ui,sans-serif" font-size="82" font-weight="800" fill="white">${escapeHtml(initials)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function updateAvatar(root: HTMLElement, profile: ChatProfile | undefined) {
  const image = root.querySelector<HTMLImageElement>(".header-avatar");
  const email = String(profile?.email || "").trim().toLowerCase();
  if (!image || !email) return;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  for (const source of [`https://www.gravatar.com/avatar/${hash}?d=404&s=256`, `https://seccdn.libravatar.org/avatar/${hash}?d=404&s=256`]) {
    const loaded = await new Promise<boolean>((resolve) => {
      const candidate = new Image();
      const timer = window.setTimeout(() => resolve(false), 5000);
      candidate.onload = () => { window.clearTimeout(timer); resolve(true); };
      candidate.onerror = () => { window.clearTimeout(timer); resolve(false); };
      candidate.referrerPolicy = "no-referrer";
      candidate.src = source;
    });
    if (loaded && image.isConnected) {
      image.src = source;
      break;
    }
  }
}
